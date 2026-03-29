import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect, Fiber, Layer, ManagedRuntime } from "effect";
import type {
	ExtensionAPI,
	ExtensionContext,
	ModelRegistry,
	ToolDefinition,
	ToolResultEvent,
	BeforeAgentStartEvent,
	ContextEvent,
} from "@mariozechner/pi-coding-agent";

import { PiAPILive } from "../src/effect/pi.js";
import { runTau } from "../src/app.js";
import initMemory from "../src/memory/index.js";
import initNudge from "../src/nudge/index.js";
import initWorkedFor from "../src/worked-for/index.js";
import { CuratedMemory, CuratedMemoryLive } from "../src/services/curated-memory.js";

function globalMemoryPath(homeDir: string): string {
	return path.join(homeDir, ".pi", "agent", "tau", "memories", "MEMORY.md");
}

function projectMemoryPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, ".pi", "tau", "memories", "PROJECT.md");
}

function userMemoryPath(homeDir: string): string {
	return path.join(homeDir, ".pi", "agent", "tau", "memories", "USER.md");
}

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

function makePiStub(): {
	readonly pi: ExtensionAPI;
	readonly tools: ToolDefinition[];
	readonly fire: (event: string, payload: unknown, ctx?: ExtensionContext) => Promise<readonly unknown[]>;
} {
	const eventHandlers = new Map<string, EventHandler[]>();
	const tools: ToolDefinition[] = [];

	const base = {
		on: (event: string, handler: EventHandler) => {
			const handlers = eventHandlers.get(event) ?? [];
			handlers.push(handler);
			eventHandlers.set(event, handlers);
		},
		getActiveTools: () => ["memory"],
		registerTool: (tool: ToolDefinition) => {
			tools.push(tool);
		},
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
		tools,
		fire: async (event, payload, ctx) => {
			const handlers = eventHandlers.get(event) ?? [];
			const context =
				ctx ??
				({
					cwd: process.cwd(),
					hasUI: false,
					ui: {
						setWidget: () => undefined,
						notify: () => undefined,
					},
				} as unknown as ExtensionContext);
			return Promise.all(handlers.map((handler) => handler(payload, context)));
		},
	};
}

function makeContext(cwd: string): ExtensionContext {
	return {
		cwd,
		hasUI: true,
		sessionManager: {
			getEntries: () => [],
			getBranch: () => [],
			getSessionId: () => "test-session",
		},
		modelRegistry: {
			find: () => ({ provider: "anthropic", id: "claude-sonnet-4-5" }),
		} as unknown as ModelRegistry,
		ui: {
			setWidget: () => undefined,
			setFooter: () => () => undefined,
			setEditorComponent: () => undefined,
			notify: () => undefined,
			setStatus: () => undefined,
		},
	} as unknown as ExtensionContext;
}

function makeRunTauStub(): {
	readonly pi: ExtensionAPI;
	readonly tools: ToolDefinition[];
	readonly fire: (event: string, payload: unknown, ctx?: ExtensionContext) => Promise<readonly unknown[]>;
} {
	const eventHandlers = new Map<string, EventHandler[]>();
	const tools: ToolDefinition[] = [];

	const base = {
		on: (event: string, handler: EventHandler) => {
			const handlers = eventHandlers.get(event) ?? [];
			handlers.push(handler);
			eventHandlers.set(event, handlers);
		},
		getActiveTools: () => tools.map((tool) => tool.name),
		registerTool: (tool: ToolDefinition) => {
			tools.push(tool);
		},
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
		tools,
		fire: async (event, payload, ctx) => {
			const handlers = eventHandlers.get(event) ?? [];
			const context = ctx ?? makeContext(process.cwd());
			return Promise.all(handlers.map((handler) => handler(payload, context)));
		},
	};
}

describe("memory tool runtime", () => {
	let tempHome: string;
	let originalHome: string | undefined;

	beforeEach(async () => {
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "tau-memory-tool-runtime-"));
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

	it("returns promptly even after tool_result handlers run during an active agent", async () => {
		const { pi, tools, fire } = makePiStub();
		const runtime = ManagedRuntime.make(CuratedMemoryLive.pipe(Layer.provide(PiAPILive(pi))));
		const runEffect = <A, E>(effect: Effect.Effect<A, E, CuratedMemory>) => runtime.runPromise(effect);
		const cwd = path.join(tempHome, "workspace");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".pi", "settings.json"), "{}", "utf8");

		try {
			const memory = await runEffect(Effect.gen(function* () {
				return yield* CuratedMemory;
			}));
			await runtime.runPromise(Effect.scoped(memory.setup));

			initMemory(pi, runEffect);
			initNudge(pi);
			initWorkedFor(pi, {
				getSnapshot: () => ({}),
				update: () => undefined,
			});

			const memoryTool = tools.find((tool) => tool.name === "memory");
			expect(memoryTool).toBeDefined();

			const ctx = makeContext(cwd);
			await fire(
				"before_agent_start",
				{
					type: "before_agent_start",
					prompt: "save memory",
					systemPrompt: "base",
				} satisfies BeforeAgentStartEvent,
				ctx,
			);

			const result = await Promise.race([
				memoryTool!.execute(
					"call-1",
					{
						action: "add",
						target: "global",
						content: "tau-memory-runtime-hang-repro",
					},
					undefined,
					undefined,
					ctx,
				),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("memory execute timed out")), 1000),
				),
			]);

			const firstContent = result.content[0];
			expect(firstContent?.type).toBe("text");
			if (firstContent?.type !== "text") {
				throw new Error("memory tool did not return text content");
			}
			expect(firstContent.text).toContain("Added entry to global memory.");
			expect(firstContent.text).toContain("<memory_snapshot>");
			expect(firstContent.text).toContain(globalMemoryPath(tempHome));
			expect(firstContent.text).toContain(projectMemoryPath(cwd));
			expect(firstContent.text).toContain(userMemoryPath(tempHome));
			expect(await fs.readFile(globalMemoryPath(tempHome), "utf8")).toBe("tau-memory-runtime-hang-repro");

			await expect(
				Promise.race([
					fire(
						"tool_result",
						{
							type: "tool_result",
							toolName: "memory",
							toolCallId: "call-1",
							input: { action: "add", target: "global", content: "tau-memory-runtime-hang-repro" },
							content: result.content,
							details: result.details,
							isError: false,
						} satisfies ToolResultEvent,
						ctx,
					),
					new Promise<never>((_, reject) =>
						setTimeout(() => reject(new Error("tool_result handlers timed out")), 1000),
					),
				]),
			).resolves.toBeDefined();
		} finally {
			await runtime.dispose();
		}
	});

	it("keeps newly saved memory out of the active-session system prompt until session_start", async () => {
		const { pi, tools, fire } = makePiStub();
		const runtime = ManagedRuntime.make(CuratedMemoryLive.pipe(Layer.provide(PiAPILive(pi))));
		const runEffect = <A, E>(effect: Effect.Effect<A, E, CuratedMemory>) => runtime.runPromise(effect);
		const cwd = path.join(tempHome, "workspace-fresh-memory");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".pi", "settings.json"), "{}", "utf8");

		try {
			const memory = await runEffect(Effect.gen(function* () {
				return yield* CuratedMemory;
			}));
			await runtime.runPromise(Effect.scoped(memory.setup));

			initMemory(pi, runEffect);

			const memoryTool = tools.find((tool) => tool.name === "memory");
			expect(memoryTool).toBeDefined();

			const ctx = makeContext(cwd);
			const firstStart = await fire(
				"before_agent_start",
				{
					type: "before_agent_start",
					prompt: "save memory",
					systemPrompt: "base",
				} satisfies BeforeAgentStartEvent,
				ctx,
			);
			expect(firstStart[0]).toEqual({ systemPrompt: "base" });

			await memoryTool!.execute(
				"call-3",
				{
					action: "add",
					target: "project",
					content: "tau-project-memory-next-agent-start",
				},
				undefined,
				undefined,
				ctx,
			);
			expect(await fs.readFile(projectMemoryPath(cwd), "utf8")).toBe("tau-project-memory-next-agent-start");

			const nextStart = await fire(
				"before_agent_start",
				{
					type: "before_agent_start",
					prompt: "save memory",
					systemPrompt: "base",
				} satisfies BeforeAgentStartEvent,
				ctx,
			);

			expect(nextStart[0]).toEqual({ systemPrompt: "base" });

			await fire("session_start", { type: "session_start" }, ctx);
			await new Promise((resolve) => setTimeout(resolve, 50));

			const reloadedStart = await fire(
				"before_agent_start",
				{
					type: "before_agent_start",
					prompt: "save memory",
					systemPrompt: "base",
				} satisfies BeforeAgentStartEvent,
				ctx,
			);

			expect(reloadedStart[0]).toEqual({ systemPrompt: expect.stringContaining("tau-project-memory-next-agent-start") });
			expect(reloadedStart[0]).toEqual({ systemPrompt: expect.stringContaining(projectMemoryPath(cwd)) });
		} finally {
			await runtime.dispose();
		}
	});

	it("does not stall when full tau context recomputation runs after memory succeeds", async () => {
		const { pi, tools, fire } = makeRunTauStub();
		const fiber = runTau(pi);
		const cwd = path.join(tempHome, "workspace-full-runtime");
		await fs.mkdir(cwd, { recursive: true });
		const ctx = makeContext(cwd);

		try {
			for (let attempts = 0; attempts < 50 && !tools.some((tool) => tool.name === "memory"); attempts++) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}

			const memoryTool = tools.find((tool) => tool.name === "memory");
			expect(memoryTool).toBeDefined();

			await fire("session_start", { type: "session_start" }, ctx);
			await fire(
				"before_agent_start",
				{
					type: "before_agent_start",
					prompt: "save this durable fact",
					systemPrompt: "base",
				} satisfies BeforeAgentStartEvent,
				ctx,
			);

			const result = await Promise.race([
				memoryTool!.execute(
					"call-2",
					{
						action: "add",
						target: "global",
						content: "tau-memory-full-runtime-repro",
					},
					undefined,
					undefined,
					ctx,
				),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("full runtime memory execute timed out")), 1500),
				),
			]);

			await Promise.race([
				fire(
					"tool_result",
					{
						type: "tool_result",
						toolName: "memory",
						toolCallId: "call-2",
						input: { action: "add", target: "global", content: "tau-memory-full-runtime-repro" },
						content: result.content,
						details: result.details,
						isError: false,
					} satisfies ToolResultEvent,
					ctx,
				),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("full runtime tool_result timed out")), 1500),
				),
			]);

			await expect(
				Promise.race([
					fire(
						"context",
						{
							type: "context",
							messages: [
								{
									role: "user",
									content: [{ type: "text", text: "continue" }],
									timestamp: Date.now(),
								},
							],
						} satisfies ContextEvent,
						ctx,
					),
					new Promise<never>((_, reject) =>
						setTimeout(() => reject(new Error("full runtime context timed out")), 1500),
					),
				]),
			).resolves.toBeDefined();
		} finally {
			await Effect.runPromise(Fiber.interrupt(fiber));
		}
	});
});
