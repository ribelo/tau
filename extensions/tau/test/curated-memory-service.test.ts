import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { PiAPILive } from "../src/effect/pi.js";
import { ENTRY_DELIMITER } from "../src/memory/format.js";
import { MemoryDuplicateEntry } from "../src/memory/errors.js";
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
	return path.join(globalMemoryDir(homeDir), "MEMORY.md");
}

function userMemoryPath(homeDir: string): string {
	return path.join(globalMemoryDir(homeDir), "USER.md");
}

function projectMemoryDir(workspaceRoot: string): string {
	return path.join(workspaceRoot, ".pi", "tau", "memories");
}

function projectMemoryPath(workspaceRoot: string): string {
	return path.join(projectMemoryDir(workspaceRoot), "PROJECT.md");
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
		await fs.writeFile(globalMemoryPath(tempHome), ["alpha"].join(ENTRY_DELIMITER), "utf8");
		await fs.writeFile(projectMemoryPath(workspaceRoot), ["project-alpha"].join(ENTRY_DELIMITER), "utf8");
		await fs.writeFile(userMemoryPath(tempHome), ["rafa"].join(ENTRY_DELIMITER), "utf8");

		const { pi, emit } = makePiStub();
		const runtime = ManagedRuntime.make(CuratedMemoryLive.pipe(Layer.provide(PiAPILive(pi))));

		try {
			const memory = await runtime.runPromise(getCuratedMemory);
			await runtime.runPromise(Effect.scoped(memory.setup));
			await emit("session_start", {}, workspaceRoot);
			await new Promise((resolve) => setTimeout(resolve, 50));

			const [initial] = await emit("before_agent_start", { systemPrompt: "base" }, workspaceRoot);
			expect(initial).toEqual({
				systemPrompt: expect.stringContaining("<memory_snapshot>"),
			});
			expect(initial).toEqual({
				systemPrompt: expect.stringContaining(globalMemoryPath(tempHome)),
			});
			expect(initial).toEqual({
				systemPrompt: expect.stringContaining(projectMemoryPath(workspaceRoot)),
			});

			await runtime.runPromise(memory.add("global", "beta", workspaceRoot));

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

			expect(await fs.readFile(projectMemoryPath(workspaceRoot), "utf8")).toBe("alpha");
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
			await runtime.runPromise(memory.add("global", "beta", workspaceRoot));

			await expect(runtime.runPromise(memory.update("global", "beta", "alpha", workspaceRoot))).rejects.toBeInstanceOf(
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
			await runtime.runPromise(memory.add("global", "alpha\r\nbeta", workspaceRoot));

			await expect(runtime.runPromise(memory.add("global", "alpha\nbeta", workspaceRoot))).rejects.toBeInstanceOf(
				MemoryDuplicateEntry,
			);

			await runtime.runPromise(memory.remove("global", "alpha\r\nbeta", workspaceRoot));
			expect(await fs.readFile(globalMemoryPath(tempHome), "utf8")).toBe("");
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

			expect(await fs.readFile(globalMemoryPath(tempHome), "utf8")).toBe("alpha");
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

			expect(await fs.readFile(globalMemoryPath(tempHome), "utf8")).toBe("beta");
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

			expect(await fs.readFile(globalMemoryPath(tempHome), "utf8")).toBe("gamma");
			await expect(fs.access(lockPath)).rejects.toThrow();
		} finally {
			await runtime.dispose();
		}
	});
});
