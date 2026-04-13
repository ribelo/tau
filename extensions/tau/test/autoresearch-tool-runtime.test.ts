import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";

import type {
	BashOperations,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
} from "@mariozechner/pi-coding-agent";

import { LoopRepoLive } from "../src/loops/repo.js";
import { LoopEngine } from "../src/services/loop-engine.js";
import { LoopEngineLive } from "../src/services/loop-engine.js";
import { PromptModes } from "../src/services/prompt-modes.js";
import { Sandbox } from "../src/services/sandbox.js";
import { makePromptModesStubLayer } from "./ralph-test-helpers.js";

const getSandboxedBashOperationsMock = vi.fn<
	(ctx: ExtensionContext, escalate: boolean) => BashOperations | undefined
>();

vi.mock("../src/sandbox/index.js", () => ({
	getSandboxedBashOperations: (ctx: ExtensionContext, escalate: boolean) =>
		getSandboxedBashOperationsMock(ctx, escalate),
}));

import initAutoresearch from "../src/autoresearch/index.js";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

type RegisteredCommand = {
	readonly handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
};

type NewSessionPlan = {
	readonly cancelled: boolean;
	readonly sessionFile?: string;
};

type ContextHarness = {
	readonly ctx: ExtensionCommandContext;
	readonly newSessionCalls: ReadonlyArray<unknown>;
	readonly setSessionFile: (next: string) => void;
};

type PiHarness = {
	readonly pi: ExtensionAPI;
	readonly commands: Map<string, RegisteredCommand>;
	readonly tools: Map<string, ToolDefinition>;
	readonly fire: (event: string, payload: unknown, ctx: ExtensionContext) => Promise<readonly unknown[]>;
};

type RuntimeHarness = {
	readonly run: <A, E>(
		effect: Effect.Effect<A, E, LoopEngine | Sandbox | PromptModes>,
	) => Promise<A>;
	readonly dispose: () => Promise<void>;
};

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tau-autoresearch-tool-runtime-"));
}

function sessionIdFromFile(sessionFile: string): string {
	return path.basename(sessionFile, path.extname(sessionFile));
}

function makeRuntime(): RuntimeHarness {
	const sandboxLayer = Layer.succeed(
		Sandbox,
		Sandbox.of({
			getConfig: Effect.succeed({
				preset: "workspace-write",
				filesystemMode: "workspace-write",
				networkMode: "deny",
				approvalPolicy: "on-request",
				approvalTimeoutSeconds: 30,
				subagent: false,
			}),
			changes: Stream.empty,
			setup: Effect.void,
		}),
	);

	const layer = LoopEngineLive.pipe(
		Layer.provideMerge(LoopRepoLive),
		Layer.provideMerge(makePromptModesStubLayer()),
		Layer.provideMerge(sandboxLayer),
		Layer.provide(NodeFileSystem.layer),
	);
	const runtime = ManagedRuntime.make(layer);
	return {
		run: (effect) => runtime.runPromise(effect),
		dispose: () => runtime.dispose(),
	};
}

function makeContext(
	cwd: string,
	newSessionPlan: readonly NewSessionPlan[] = [{ cancelled: false }],
): ContextHarness {
	const newSessionCalls: unknown[] = [];
	let sessionFile = path.join(cwd, ".pi", "sessions", "controller.session.json");
	let sessionId = sessionIdFromFile(sessionFile);
	let newSessionCounter = 0;

	const setSessionFile = (next: string): void => {
		sessionFile = next;
		sessionId = sessionIdFromFile(next);
	};

	const ctx = {
		cwd,
		hasUI: true,
		model: undefined,
		modelRegistry: {
			find: (provider: string, id: string) => ({ provider, id }),
			getAll: () => [],
		},
		sessionManager: {
			getEntries: () => [],
			getBranch: () => [],
			getSessionId: () => sessionId,
			getSessionFile: () => sessionFile,
		},
		ui: {
			setStatus: () => undefined,
			setWidget: () => undefined,
			setFooter: () => () => undefined,
			setEditorComponent: () => undefined,
			notify: () => undefined,
			confirm: async () => true,
			getEditorText: () => "",
			theme: {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			},
		},
		isIdle: () => true,
		abort: () => undefined,
		hasPendingMessages: () => false,
		shutdown: () => undefined,
		getContextUsage: () => undefined,
		compact: () => undefined,
		getSystemPrompt: () => "",
		waitForIdle: async () => undefined,
		newSession: async (options?: unknown) => {
			newSessionCalls.push(options);
			const plan = newSessionPlan[newSessionCounter] ?? { cancelled: false };
			newSessionCounter += 1;
			if (!plan.cancelled) {
				const nextSessionFile =
					plan.sessionFile ??
					path.join(cwd, ".pi", "sessions", `child-${newSessionCounter}.session.json`);
				setSessionFile(nextSessionFile);
			}
			return { cancelled: plan.cancelled };
		},
		switchSession: async (target: string) => {
			setSessionFile(target);
			return { cancelled: false };
		},
	};

	return {
		ctx: ctx as unknown as ExtensionCommandContext,
		newSessionCalls,
		setSessionFile,
	};
}

function makePiHarness(): PiHarness {
	const eventHandlers = new Map<string, EventHandler[]>();
	const commands = new Map<string, RegisteredCommand>();
	const tools = new Map<string, ToolDefinition>();

	const base = {
		on: (event: string, handler: EventHandler) => {
			const handlers = eventHandlers.get(event) ?? [];
			handlers.push(handler);
			eventHandlers.set(event, handlers);
		},
		registerCommand: (name: string, command: RegisteredCommand) => {
			commands.set(name, command);
		},
		registerTool: (tool: ToolDefinition) => {
			tools.set(tool.name, tool);
		},
		registerShortcut: () => undefined,
		registerFlag: () => undefined,
		registerMessageRenderer: () => undefined,
		sendUserMessage: () => undefined,
		sendMessage: () => undefined,
		appendEntry: () => undefined,
		getActiveTools: () => [],
		setActiveTools: () => undefined,
		getAllTools: () => [],
		getCommands: () => [],
		setModel: async () => true,
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => undefined,
		events: {
			emit: () => undefined,
			on: (event: string, handler: EventHandler) => {
				base.on(event, handler);
				return () => undefined;
			},
		},
	};

	return {
		pi: new Proxy(base, {
			get(target, prop, receiver) {
				if (Reflect.has(target, prop)) {
					return Reflect.get(target, prop, receiver);
				}
				return () => undefined;
			},
		}) as unknown as ExtensionAPI,
		commands,
		tools,
		fire: async (event, payload, ctx) => {
			const results: unknown[] = [];
			for (const handler of eventHandlers.get(event) ?? []) {
				results.push(await Promise.resolve(handler(payload, ctx)));
			}
			return results;
		},
	};
}

describe("autoresearch tool runtime", () => {
	const tempDirs: string[] = [];
	const runtimes: RuntimeHarness[] = [];

	afterEach(async () => {
		getSandboxedBashOperationsMock.mockReset();
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		for (const runtime of runtimes.splice(0)) {
			await runtime.dispose();
		}
	});

	it("runs the benchmark in the real workspace scope", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const context = makeContext(cwd);
		const piHarness = makePiHarness();
		const runtime = makeRuntime();
		runtimes.push(runtime);
		initAutoresearch(piHarness.pi, runtime.run);

		const execCalls: Array<{ readonly command: string; readonly cwd: string }> = [];
		getSandboxedBashOperationsMock.mockReturnValue({
			exec: async (command, commandCwd, options) => {
				execCalls.push({ command, cwd: commandCwd });

				if (command === "bash autoresearch.sh") {
					options.onData?.(Buffer.from('METRIC metric=123\nASI hypothesis="workspace"\n'));
					return { exitCode: 0 };
				}

				throw new Error(`Unexpected command: ${command}`);
			},
		} as BashOperations);

		const command = piHarness.commands.get("autoresearch");
		expect(command).toBeDefined();
		await command?.handler("create improve-local-pdp-web-vitals", context.ctx);
		await command?.handler("start improve-local-pdp-web-vitals", context.ctx);
		expect(context.newSessionCalls).toHaveLength(1);

		const runTool = piHarness.tools.get("autoresearch_run");
		if (runTool === undefined) {
			throw new Error("autoresearch_run tool was not registered");
		}

		await runTool.execute(
			"tool-call-1",
			{},
			new AbortController().signal,
			undefined,
			context.ctx,
		);
		const benchmarkCalls = execCalls.filter((call) => call.command === "bash autoresearch.sh");
		expect(benchmarkCalls).toHaveLength(1);
		expect(benchmarkCalls[0]?.cwd).toBe(cwd);
	});

	it("auto-commits kept runs in the real workspace", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const context = makeContext(cwd);
		const piHarness = makePiHarness();
		const runtime = makeRuntime();
		runtimes.push(runtime);
		initAutoresearch(piHarness.pi, runtime.run);

		const execCalls: Array<{ readonly command: string; readonly cwd: string }> = [];
		getSandboxedBashOperationsMock.mockReturnValue({
			exec: async (command, commandCwd, options) => {
				execCalls.push({ command, cwd: commandCwd });

				if (command === "bash autoresearch.sh") {
					options.onData?.(Buffer.from('METRIC metric=123\nASI hypothesis="workspace"\n'));
					return { exitCode: 0 };
				}
				if (command === "git add -A") {
					return { exitCode: 0 };
				}
				if (command === "git diff --cached --quiet") {
					return { exitCode: 1 };
				}
				if (command.startsWith("git commit -m ")) {
					options.onData?.(Buffer.from("[master abc1234] autoresearch keep\n 1 file changed\n"));
					return { exitCode: 0 };
				}
				if (command === "git rev-parse --short=7 HEAD") {
					options.onData?.(Buffer.from("abc1234\n"));
					return { exitCode: 0 };
				}

				throw new Error(`Unexpected command: ${command}`);
			},
		} as BashOperations);

		const command = piHarness.commands.get("autoresearch");
		if (command === undefined) {
			throw new Error("autoresearch command was not registered");
		}
		await command.handler("create improve-local-pdp-web-vitals", context.ctx);
		await command.handler("start improve-local-pdp-web-vitals", context.ctx);

		const runTool = piHarness.tools.get("autoresearch_run");
		const doneTool = piHarness.tools.get("autoresearch_done");
		if (runTool === undefined || doneTool === undefined) {
			throw new Error("autoresearch tools were not registered");
		}

		await runTool.execute("tool-call-1", {}, new AbortController().signal, undefined, context.ctx);
		const doneResult = await doneTool.execute(
			"tool-call-2",
			{ status: "keep", description: "kept improvement", asi: { hypothesis: "workspace" } },
			new AbortController().signal,
			undefined,
			context.ctx,
		);

		expect(execCalls.map((call) => call.command)).toContain("git add -A");
		expect(execCalls.map((call) => call.command)).toContain("git diff --cached --quiet");
		expect(execCalls.some((call) => call.command.startsWith("git commit -m "))).toBe(true);
		expect(execCalls.map((call) => call.command)).toContain("git rev-parse --short=7 HEAD");
		expect(doneResult.content[0]?.type).toBe("text");
		if (doneResult.content[0]?.type !== "text") {
			throw new Error("expected text result");
		}
		expect(doneResult.content[0].text).toContain("Git: committed");
	});

	it("auto-reverts discarded runs in the real workspace", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const context = makeContext(cwd);
		const piHarness = makePiHarness();
		const runtime = makeRuntime();
		runtimes.push(runtime);
		initAutoresearch(piHarness.pi, runtime.run);

		const execCalls: Array<{ readonly command: string; readonly cwd: string }> = [];
		getSandboxedBashOperationsMock.mockReturnValue({
			exec: async (command, commandCwd, options) => {
				execCalls.push({ command, cwd: commandCwd });

				if (command === "bash autoresearch.sh") {
					options.onData?.(Buffer.from('METRIC metric=123\nASI hypothesis="workspace"\n'));
					return { exitCode: 0 };
				}
				if (command === "git checkout -- .") {
					return { exitCode: 0 };
				}
				if (command === "git clean -fd") {
					return { exitCode: 0 };
				}

				throw new Error(`Unexpected command: ${command}`);
			},
		} as BashOperations);

		const command = piHarness.commands.get("autoresearch");
		if (command === undefined) {
			throw new Error("autoresearch command was not registered");
		}
		await command.handler("create improve-local-pdp-web-vitals", context.ctx);
		await command.handler("start improve-local-pdp-web-vitals", context.ctx);

		const runTool = piHarness.tools.get("autoresearch_run");
		const doneTool = piHarness.tools.get("autoresearch_done");
		if (runTool === undefined || doneTool === undefined) {
			throw new Error("autoresearch tools were not registered");
		}

		await runTool.execute("tool-call-1", {}, new AbortController().signal, undefined, context.ctx);
		const doneResult = await doneTool.execute(
			"tool-call-2",
			{ status: "discard", description: "discarded idea", asi: { hypothesis: "workspace" } },
			new AbortController().signal,
			undefined,
			context.ctx,
		);

		expect(execCalls.map((call) => call.command)).toContain("git checkout -- .");
		expect(execCalls.map((call) => call.command)).toContain("git clean -fd");
		expect(doneResult.content[0]?.type).toBe("text");
		if (doneResult.content[0]?.type !== "text") {
			throw new Error("expected text result");
		}
		expect(doneResult.content[0].text).toContain("Git: reverted workspace changes (discard)");
	});
});
