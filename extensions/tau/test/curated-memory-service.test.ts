import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { PiAPILive } from "../src/effect/pi.js";
import { createMemoryEntry, ENTRY_DELIMITER, parseMemoryEntries, serializeMemoryEntries } from "../src/memory/format.js";
import { MemoryDuplicateEntry, MemoryEntryTooLarge, MemoryNoMatch } from "../src/memory/errors.js";
import { CuratedMemory, CuratedMemoryLive } from "../src/services/curated-memory.js";

const getCuratedMemory = Effect.gen(function* () {
	return yield* CuratedMemory;
});

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

function makeContext(cwd: string): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		ui: {
			setWidget: () => undefined,
			notify: () => undefined,
		},
	} as unknown as ExtensionContext;
}

function globalMemoryDir(homeDir: string): string {
	return path.join(homeDir, ".pi", "agent", "tau", "memories");
}

function globalMemoryPath(homeDir: string): string {
	return path.join(globalMemoryDir(homeDir), "MEMORY.jsonl");
}

function userMemoryPath(homeDir: string): string {
	return path.join(globalMemoryDir(homeDir), "USER.jsonl");
}

function projectMemoryDir(workspaceRoot: string): string {
	return path.join(workspaceRoot, ".pi", "tau", "memories");
}

function projectMemoryPath(workspaceRoot: string): string {
	return path.join(projectMemoryDir(workspaceRoot), "PROJECT.jsonl");
}

function legacyGlobalMemoryPath(homeDir: string): string {
	return path.join(globalMemoryDir(homeDir), "MEMORY.md");
}

function makePiStub(): {
	readonly pi: ExtensionAPI;
	readonly emit: (event: string, payload: unknown, cwd: string) => Promise<readonly unknown[]>;
} {
	const eventHandlers = new Map<string, EventHandler[]>();

	const base = {
		on: (event: string, handler: EventHandler) => {
			const handlers = eventHandlers.get(event) ?? [];
			handlers.push(handler);
			eventHandlers.set(event, handlers);
		},
		registerTool: () => undefined,
		registerCommand: () => undefined,
		registerShortcut: () => undefined,
		registerMessageRenderer: () => undefined,
		registerFlag: () => undefined,
		sendMessage: () => undefined,
		appendEntry: () => undefined,
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => undefined,
		setModel: async () => true,
		getFlag: () => undefined,
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		events: {
			emit: () => undefined,
			on: () => () => undefined,
		},
	};

	const pi = new Proxy(base, {
		get(target, prop, receiver) {
			if (Reflect.has(target, prop)) {
				return Reflect.get(target, prop, receiver);
			}
			return () => undefined;
		},
	}) as unknown as ExtensionAPI;

	return {
		pi,
		emit: async (event, payload, cwd) => {
			const handlers = eventHandlers.get(event) ?? [];
			const ctx = makeContext(cwd);
			return Promise.all(handlers.map((handler) => handler(payload, ctx)));
		},
	};
}

describe("CuratedMemory service", () => {
	let tempHome: string;
	let workspaceRoot: string;
	let originalHome: string | undefined;

	beforeEach(async () => {
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "tau-memory-"));
		workspaceRoot = path.join(tempHome, "workspace");
		await fs.mkdir(path.join(workspaceRoot, ".pi"), { recursive: true });
		await fs.writeFile(path.join(workspaceRoot, ".pi", "settings.json"), "{}", "utf8");
		originalHome = process.env["HOME"];
		process.env["HOME"] = tempHome;
	});

	afterEach(async () => {
		if (originalHome === undefined) {
			delete process.env["HOME"];
		} else {
			process.env["HOME"] = originalHome;
		}
		await fs.rm(tempHome, { recursive: true, force: true });
	});

	it("keeps the injected XML snapshot frozen until session_start reload", async () => {
		await fs.mkdir(globalMemoryDir(tempHome), { recursive: true });
		await fs.mkdir(projectMemoryDir(workspaceRoot), { recursive: true });
		await fs.writeFile(
			globalMemoryPath(tempHome),
			serializeMemoryEntries([createMemoryEntry("alpha", { scope: "global" })]),
			"utf8",
		);
		await fs.writeFile(
			projectMemoryPath(workspaceRoot),
			serializeMemoryEntries([createMemoryEntry("project-alpha", { scope: "project" })]),
			"utf8",
		);
		await fs.writeFile(
			userMemoryPath(tempHome),
			serializeMemoryEntries([createMemoryEntry("rafa", { scope: "user" })]),
			"utf8",
		);

		const { pi, emit } = makePiStub();
		const runtime = ManagedRuntime.make(CuratedMemoryLive.pipe(Layer.provide(PiAPILive(pi))));

		try {
			const memory = await runtime.runPromise(getCuratedMemory);
			await runtime.runPromise(Effect.scoped(memory.setup));
			await emit("session_start", {}, workspaceRoot);
			await new Promise((resolve) => setTimeout(resolve, 50));

		const [initial] = await emit("before_agent_start", { systemPrompt: "base" }, workspaceRoot);
		expect(initial).toEqual({
			systemPrompt: expect.stringContaining("<memory_index>"),
		});
		expect(initial).toEqual({
			systemPrompt: expect.stringContaining('scope="global"'),
		});
		expect(initial).toEqual({
			systemPrompt: expect.stringContaining('scope="project"'),
		});
		expect(initial).toEqual({
			systemPrompt: expect.stringContaining('scope="user"'),
		});
		// Should contain summaries, not full content paths
		expect(initial).toEqual({
			systemPrompt: expect.stringContaining("alpha"),
		});			await runtime.runPromise(memory.add("global", "beta", workspaceRoot));

			const [stillFrozen] = await emit("before_agent_start", { systemPrompt: "base" }, workspaceRoot);
			expect(stillFrozen).toEqual({
				systemPrompt: expect.not.stringContaining("beta"),
			});

			await emit("session_start", {}, workspaceRoot);
			await new Promise((resolve) => setTimeout(resolve, 50));

			const [reloaded] = await emit("before_agent_start", { systemPrompt: "base" }, workspaceRoot);
			expect(reloaded).toEqual({
				systemPrompt: expect.stringContaining("beta"),
			});
		} finally {
			await runtime.dispose();
		}
	});

	it("stores project memory in the nearest workspace .pi directory", async () => {
		const nestedCwd = path.join(workspaceRoot, "src", "nested");
		await fs.mkdir(nestedCwd, { recursive: true });

		const { pi } = makePiStub();
		const runtime = ManagedRuntime.make(CuratedMemoryLive.pipe(Layer.provide(PiAPILive(pi))));

		try {
			const memory = await runtime.runPromise(getCuratedMemory);
			await runtime.runPromise(memory.add("project", "alpha", nestedCwd));

			expect(parseMemoryEntries(await fs.readFile(projectMemoryPath(workspaceRoot), "utf8")).map((entry) => entry.content)).toEqual(["alpha"]);
		} finally {
			await runtime.dispose();
		}
	});

	it("migrates legacy markdown memory files to jsonl on first read", async () => {
		await fs.mkdir(globalMemoryDir(tempHome), { recursive: true });
		await fs.writeFile(legacyGlobalMemoryPath(tempHome), ["alpha", "beta"].join(ENTRY_DELIMITER), "utf8");

		const { pi } = makePiStub();
		const runtime = ManagedRuntime.make(CuratedMemoryLive.pipe(Layer.provide(PiAPILive(pi))));

		try {
			const memory = await runtime.runPromise(getCuratedMemory);
			const snapshot = await runtime.runPromise(memory.getSnapshot(workspaceRoot));

			expect(snapshot.global.entries).toEqual(["alpha", "beta"]);
			expect(parseMemoryEntries(await fs.readFile(globalMemoryPath(tempHome), "utf8")).map((entry) => entry.content)).toEqual(["alpha", "beta"]);
			await expect(fs.access(legacyGlobalMemoryPath(tempHome))).rejects.toThrow();
		} finally {
			await runtime.dispose();
		}
	});

	it("migrates legacy long ids to short ids before appending new memory", async () => {
		await fs.mkdir(globalMemoryDir(tempHome), { recursive: true });
		const legacyId = "itoVz1h0QCl_78gmCgjPG";
		await fs.writeFile(
			globalMemoryPath(tempHome),
			[
				JSON.stringify({
					id: legacyId,
					content: "existing-entry",
					createdAt: "2026-03-29T11:14:07.584Z",
					updatedAt: "2026-03-29T11:14:07.584Z",
				}),
			].join("\n"),
			"utf8",
		);

		const { pi } = makePiStub();
		const runtime = ManagedRuntime.make(CuratedMemoryLive.pipe(Layer.provide(PiAPILive(pi))));

		try {
			const memory = await runtime.runPromise(getCuratedMemory);
			await runtime.runPromise(memory.add("global", "new-entry", workspaceRoot));

			const entries = parseMemoryEntries(await fs.readFile(globalMemoryPath(tempHome), "utf8"), {
				scope: "global",
			});

			expect(entries.map((entry) => entry.content)).toEqual(["existing-entry", "new-entry"]);
			expect(entries.map((entry) => entry.id)).toHaveLength(2);
			expect(entries[0]?.id).not.toBe(legacyId);
			expect(entries[0]?.id.length).toBe(12);
			expect(entries[1]?.id.length).toBe(12);
			expect(new Set(entries.map((entry) => entry.id)).size).toBe(2);
			expect(entries.map((entry) => entry.scope)).toEqual(["global", "global"]);
			expect(entries[0]?.type).toBe("fact");
			expect(entries[0]?.summary).toBe("existing-entry");
		} finally {
			await runtime.dispose();
		}
	});

	it("migrates legacy long ids during setup startup reload", async () => {
		await fs.mkdir(globalMemoryDir(tempHome), { recursive: true });
		const legacyId = "HN855CdkM_Jf2ceFiuvjC";
		await fs.writeFile(
			globalMemoryPath(tempHome),
			[
				JSON.stringify({
					id: legacyId,
					content: "startup-migration",
					createdAt: "2026-03-29T11:14:07.584Z",
					updatedAt: "2026-03-29T11:14:07.584Z",
				}),
			].join("\n"),
			"utf8",
		);

		const { pi } = makePiStub();
		const runtime = ManagedRuntime.make(CuratedMemoryLive.pipe(Layer.provide(PiAPILive(pi))));

		try {
			const memory = await runtime.runPromise(getCuratedMemory);
			await runtime.runPromise(Effect.scoped(memory.setup));

			const entries = parseMemoryEntries(await fs.readFile(globalMemoryPath(tempHome), "utf8"), {
				scope: "global",
			});

			expect(entries).toHaveLength(1);
			expect(entries[0]?.id).not.toBe(legacyId);
			expect(entries[0]?.id.length).toBe(12);
			expect(entries[0]?.content).toBe("startup-migration");
		} finally {
			await runtime.dispose();
		}
	});

	it("rejects updates that would collide with an existing entry", async () => {
		const { pi } = makePiStub();
		const runtime = ManagedRuntime.make(CuratedMemoryLive.pipe(Layer.provide(PiAPILive(pi))));

		try {
			const memory = await runtime.runPromise(getCuratedMemory);
			await runtime.runPromise(memory.add("global", "alpha", workspaceRoot));
			const beta = await runtime.runPromise(memory.add("global", "beta", workspaceRoot));

			await expect(runtime.runPromise(memory.update("global", beta.entry.id, "alpha", workspaceRoot))).rejects.toBeInstanceOf(
				MemoryDuplicateEntry,
			);
		} finally {
			await runtime.dispose();
		}
	});

	it("normalizes CRLF mutation input before matching and duplicate checks", async () => {
		const { pi } = makePiStub();
		const runtime = ManagedRuntime.make(CuratedMemoryLive.pipe(Layer.provide(PiAPILive(pi))));

		try {
			const memory = await runtime.runPromise(getCuratedMemory);
			const added = await runtime.runPromise(memory.add("global", "alpha\r\nbeta", workspaceRoot));

			await expect(runtime.runPromise(memory.add("global", "alpha\nbeta", workspaceRoot))).rejects.toBeInstanceOf(
				MemoryDuplicateEntry,
			);

			await runtime.runPromise(memory.remove("global", added.entry.id, workspaceRoot));
			expect(await fs.readFile(globalMemoryPath(tempHome), "utf8")).toBe("");
		} finally {
			await runtime.dispose();
		}
	});

	it("updates and removes entries by exact id", async () => {
		const { pi } = makePiStub();
		const runtime = ManagedRuntime.make(CuratedMemoryLive.pipe(Layer.provide(PiAPILive(pi))));

		try {
			const memory = await runtime.runPromise(getCuratedMemory);
			const first = await runtime.runPromise(memory.add("global", "alpha", workspaceRoot));
			await runtime.runPromise(memory.add("global", "alpha detail", workspaceRoot));

			const updated = await runtime.runPromise(memory.update("global", first.entry.id, "alpha revised", workspaceRoot));
			expect(updated.entry.id).toBe(first.entry.id);

			await runtime.runPromise(memory.remove("global", first.entry.id, workspaceRoot));

			expect(parseMemoryEntries(await fs.readFile(globalMemoryPath(tempHome), "utf8")).map((entry) => entry.content)).toEqual([
				"alpha detail",
			]);
		} finally {
			await runtime.dispose();
		}
	});

	it("rejects mutations that exceed the per-scope total character limit", async () => {
		const { pi } = makePiStub();
		const runtime = ManagedRuntime.make(CuratedMemoryLive.pipe(Layer.provide(PiAPILive(pi))));

		try {
			const memory = await runtime.runPromise(getCuratedMemory);
			await runtime.runPromise(memory.add("project", "p".repeat(15_000), workspaceRoot));
			await runtime.runPromise(memory.add("project", "q".repeat(9_000), workspaceRoot));
			await runtime.runPromise(memory.add("global", "g".repeat(24_000), workspaceRoot));
			const userEntry = await runtime.runPromise(memory.add("user", "u".repeat(15_000), workspaceRoot));
			await runtime.runPromise(memory.add("user", "v".repeat(8_000), workspaceRoot));

			await expect(runtime.runPromise(memory.add("project", "z".repeat(1_000), workspaceRoot))).rejects.toBeInstanceOf(
				MemoryEntryTooLarge,
			);

			await expect(runtime.runPromise(memory.add("global", "h".repeat(1_000), workspaceRoot))).rejects.toBeInstanceOf(
				MemoryEntryTooLarge,
			);

			await expect(runtime.runPromise(memory.update("user", userEntry.entry.id, "u".repeat(17_000), workspaceRoot))).rejects.toBeInstanceOf(
				MemoryEntryTooLarge,
			);
		} finally {
			await runtime.dispose();
		}
	});

	it("computes usage percentage from total scope chars", async () => {
		const { pi } = makePiStub();
		const runtime = ManagedRuntime.make(CuratedMemoryLive.pipe(Layer.provide(PiAPILive(pi))));

		try {
			const memory = await runtime.runPromise(getCuratedMemory);
			await runtime.runPromise(memory.add("project", "a".repeat(1000), workspaceRoot));
			await runtime.runPromise(memory.add("project", "b".repeat(300), workspaceRoot));

			const snapshot = await runtime.runPromise(memory.getSnapshot(workspaceRoot));

			expect(snapshot.project.chars).toBe(1303);
			expect(snapshot.project.limitChars).toBe(25_000);
			expect(snapshot.project.usagePercent).toBe(Math.floor((1303 / 25_000) * 100));
		} finally {
			await runtime.dispose();
		}
	});

	it("recovers from orphaned lock files owned by dead processes", async () => {
		await fs.mkdir(globalMemoryDir(tempHome), { recursive: true });
		await fs.writeFile(
			path.join(globalMemoryDir(tempHome), ".lock"),
			JSON.stringify({ pid: 999_999, token: "orphaned-lock" }),
			"utf8",
		);

		const { pi } = makePiStub();
		const runtime = ManagedRuntime.make(CuratedMemoryLive.pipe(Layer.provide(PiAPILive(pi))));

		try {
			const memory = await runtime.runPromise(getCuratedMemory);
			await runtime.runPromise(memory.add("global", "alpha", workspaceRoot));

			expect(parseMemoryEntries(await fs.readFile(globalMemoryPath(tempHome), "utf8")).map((entry) => entry.content)).toEqual(["alpha"]);
			await expect(fs.access(path.join(globalMemoryDir(tempHome), ".lock"))).rejects.toThrow();
		} finally {
			await runtime.dispose();
		}
	});

	it("recovers from stale lock files with unreadable metadata", async () => {
		await fs.mkdir(globalMemoryDir(tempHome), { recursive: true });
		const lockPath = path.join(globalMemoryDir(tempHome), ".lock");
		await fs.writeFile(lockPath, "{", "utf8");
		const staleAt = new Date(Date.now() - 10_000);
		await fs.utimes(lockPath, staleAt, staleAt);

		const { pi } = makePiStub();
		const runtime = ManagedRuntime.make(CuratedMemoryLive.pipe(Layer.provide(PiAPILive(pi))));

		try {
			const memory = await runtime.runPromise(getCuratedMemory);
			await runtime.runPromise(memory.add("global", "beta", workspaceRoot));

			expect(parseMemoryEntries(await fs.readFile(globalMemoryPath(tempHome), "utf8")).map((entry) => entry.content)).toEqual(["beta"]);
			await expect(fs.access(lockPath)).rejects.toThrow();
		} finally {
			await runtime.dispose();
		}
	});

	it("reclaims stale lock files even when the recorded pid is still alive", async () => {
		await fs.mkdir(globalMemoryDir(tempHome), { recursive: true });
		const lockPath = path.join(globalMemoryDir(tempHome), ".lock");
		await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, token: "stale-live-pid" }), "utf8");
		const staleAt = new Date(Date.now() - 10_000);
		await fs.utimes(lockPath, staleAt, staleAt);

		const { pi } = makePiStub();
		const runtime = ManagedRuntime.make(CuratedMemoryLive.pipe(Layer.provide(PiAPILive(pi))));

		try {
			const memory = await runtime.runPromise(getCuratedMemory);
			await runtime.runPromise(memory.add("global", "gamma", workspaceRoot));

			expect(parseMemoryEntries(await fs.readFile(globalMemoryPath(tempHome), "utf8")).map((entry) => entry.content)).toEqual(["gamma"]);
			await expect(fs.access(lockPath)).rejects.toThrow();
		} finally {
			await runtime.dispose();
		}
	});

	it("reads entries by id from any scope", async () => {
		await fs.mkdir(globalMemoryDir(tempHome), { recursive: true });
		await fs.mkdir(projectMemoryDir(workspaceRoot), { recursive: true });

		const { pi } = makePiStub();
		const runtime = ManagedRuntime.make(CuratedMemoryLive.pipe(Layer.provide(PiAPILive(pi))));

		try {
			const memory = await runtime.runPromise(getCuratedMemory);
			const projectEntry = await runtime.runPromise(memory.add("project", "project-specific content", workspaceRoot));
			const globalEntry = await runtime.runPromise(memory.add("global", "global-shared content", workspaceRoot));
			const userEntry = await runtime.runPromise(memory.add("user", "user-specific content", workspaceRoot));

			// Read each entry by id
			const readProject = await runtime.runPromise(memory.read(projectEntry.entry.id, workspaceRoot));
			expect(readProject.id).toBe(projectEntry.entry.id);
			expect(readProject.content).toBe("project-specific content");
			expect(readProject.scope).toBe("project");

			const readGlobal = await runtime.runPromise(memory.read(globalEntry.entry.id, workspaceRoot));
			expect(readGlobal.id).toBe(globalEntry.entry.id);
			expect(readGlobal.content).toBe("global-shared content");
			expect(readGlobal.scope).toBe("global");

			const readUser = await runtime.runPromise(memory.read(userEntry.entry.id, workspaceRoot));
			expect(readUser.id).toBe(userEntry.entry.id);
			expect(readUser.content).toBe("user-specific content");
			expect(readUser.scope).toBe("user");
		} finally {
			await runtime.dispose();
		}
	});

	it("fails to read with clear error for non-existent id", async () => {
		await fs.mkdir(globalMemoryDir(tempHome), { recursive: true });
		await fs.mkdir(projectMemoryDir(workspaceRoot), { recursive: true });

		const { pi } = makePiStub();
		const runtime = ManagedRuntime.make(CuratedMemoryLive.pipe(Layer.provide(PiAPILive(pi))));

		try {
			const memory = await runtime.runPromise(getCuratedMemory);
			await expect(runtime.runPromise(memory.read("nonexistent123", workspaceRoot))).rejects.toBeInstanceOf(MemoryNoMatch);
		} finally {
			await runtime.dispose();
		}
	});
});
