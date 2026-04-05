import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer, ManagedRuntime, Option } from "effect";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
} from "@mariozechner/pi-coding-agent";

import initRalph from "../src/ralph/index.js";
import { RalphRepoLive } from "../src/ralph/repo.js";
import { decodeLoopStateSync, encodeLoopStateJsonSync } from "../src/ralph/schema.js";
import { Ralph, RalphLive } from "../src/services/ralph.js";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

type RegisteredCommand = {
	readonly handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
};

type ToolExecutionResult = {
	readonly content: readonly { readonly type: "text"; readonly text: string }[];
	readonly details: Record<string, unknown>;
	readonly isError?: boolean;
};

type SentUserMessage = {
	readonly content: string | readonly { readonly type: string; readonly text?: string }[];
	readonly options?: {
		readonly deliverAs?: "steer" | "followUp";
	};
};

type Notifications = Array<{ readonly message: string; readonly level: string }>;
type WidgetUpdates = Array<readonly string[] | undefined>;
type StatusUpdates = Array<string | undefined>;

type ContextHarness = {
	readonly ctx: ExtensionCommandContext;
	readonly notifications: Notifications;
	readonly widgetUpdates: WidgetUpdates;
	readonly statusUpdates: StatusUpdates;
	readonly newSessionCalls: ReadonlyArray<unknown>;
	readonly switchSessionCalls: readonly string[];
	readonly setSessionFile: (next: string) => void;
	readonly getSessionFile: () => string;
};

type NewSessionPlan = {
	readonly cancelled: boolean;
	readonly sessionFile?: string;
};

type RalphRuntimeHarness = {
	readonly run: <A, E>(effect: Effect.Effect<A, E, Ralph>) => Promise<A>;
	readonly dispose: () => Promise<void>;
};

type PiHarness = {
	readonly pi: ExtensionAPI;
	readonly commands: Map<string, RegisteredCommand>;
	readonly tools: Map<string, ToolDefinition>;
	readonly sentUserMessages: SentUserMessage[];
	readonly fire: (event: string, payload: unknown, ctx: ExtensionContext) => Promise<readonly unknown[]>;
};

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tau-ralph-adapter-"));
}

function loopStatePath(cwd: string, loopName: string): string {
	return path.join(cwd, ".pi", "ralph", "state", `${loopName}.state.json`);
}

function readLoopState(cwd: string, loopName: string) {
	const raw = JSON.parse(fs.readFileSync(loopStatePath(cwd, loopName), "utf-8"));
	return decodeLoopStateSync(raw);
}

function writeLoopState(
	cwd: string,
	loopName: string,
	input: {
		readonly controllerSessionFile: string;
		readonly activeIterationSessionFile?: string;
		readonly status?: "active" | "paused" | "completed";
		readonly iteration?: number;
	},
): void {
	const filePath = loopStatePath(cwd, loopName);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const taskFile = path.join(".pi", "ralph", "tasks", `${loopName}.md`);
	fs.mkdirSync(path.join(cwd, path.dirname(taskFile)), { recursive: true });
	fs.writeFileSync(path.join(cwd, taskFile), "# Task\n", "utf-8");
	fs.writeFileSync(
		filePath,
		encodeLoopStateJsonSync({
			name: loopName,
			taskFile,
			iteration: input.iteration ?? 1,
			maxIterations: 50,
			itemsPerIteration: 0,
			reflectEvery: 0,
			reflectInstructions: "reflect",
			status: input.status ?? "active",
			startedAt: "2026-01-01T00:00:00.000Z",
			completedAt: Option.none(),
			lastReflectionAt: 0,
			controllerSessionFile: Option.some(input.controllerSessionFile),
			activeIterationSessionFile:
				input.activeIterationSessionFile === undefined
					? Option.none()
					: Option.some(input.activeIterationSessionFile),
			advanceRequestedAt: Option.none(),
			awaitingFinalize: false,
		}),
		"utf-8",
	);
}

function makeRalphRuntime(activeSubagents = false): RalphRuntimeHarness {
	const layer = RalphLive({
		hasActiveSubagents: () => Effect.succeed(activeSubagents),
	}).pipe(Layer.provideMerge(RalphRepoLive), Layer.provide(NodeFileSystem.layer));
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
	const notifications: Notifications = [];
	const widgetUpdates: WidgetUpdates = [];
	const statusUpdates: StatusUpdates = [];
	const newSessionCalls: unknown[] = [];
	const switchSessionCalls: string[] = [];
	let sessionFile = path.join(cwd, ".pi", "sessions", "controller.session.json");
	let newSessionCounter = 0;

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
			getSessionId: () => "test-session",
			getSessionFile: () => sessionFile,
		},
		ui: {
			setStatus: (_key: string, text: string | undefined) => {
				statusUpdates.push(text);
			},
			setWidget: (_key: string, content: string[] | undefined) => {
				widgetUpdates.push(content);
			},
			setFooter: () => () => undefined,
			setEditorComponent: () => undefined,
			notify: (message: string, level: string) => {
				notifications.push({ message, level });
			},
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
				sessionFile =
					plan.sessionFile ??
					path.join(cwd, ".pi", "sessions", `child-${newSessionCounter}.session.json`);
			}
			return { cancelled: plan.cancelled };
		},
		fork: async () => ({ cancelled: false }),
		navigateTree: async () => ({ cancelled: false }),
		switchSession: async (target: string) => {
			switchSessionCalls.push(target);
			sessionFile = target;
			return { cancelled: false };
		},
		reload: async () => undefined,
	} as unknown as ExtensionCommandContext;

	return {
		ctx,
		notifications,
		widgetUpdates,
		statusUpdates,
		newSessionCalls,
		switchSessionCalls,
		setSessionFile: (next) => {
			sessionFile = next;
		},
		getSessionFile: () => sessionFile,
	};
}

function makePiHarness(): PiHarness {
	const eventHandlers = new Map<string, EventHandler[]>();
	const commands = new Map<string, RegisteredCommand>();
	const tools = new Map<string, ToolDefinition>();
	const sentUserMessages: SentUserMessage[] = [];

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
		sendUserMessage: (
			content: string | readonly { readonly type: string; readonly text?: string }[],
			options?: { readonly deliverAs?: "steer" | "followUp" },
		) => {
			if (options === undefined) {
				sentUserMessages.push({ content });
				return;
			}
			sentUserMessages.push({ content, options });
		},
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
			on: () => () => undefined,
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
		sentUserMessages,
		fire: async (event, payload, ctx) => {
			const results: unknown[] = [];
			for (const handler of eventHandlers.get(event) ?? []) {
				results.push(await Promise.resolve(handler(payload, ctx)));
			}
			return results;
		},
	};
}

function agentEndPayload(text: string) {
	return {
		type: "agent_end",
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text }],
			},
		],
	};
}

describe("ralph adapter boundary freeze", () => {
	const tempDirs: string[] = [];
	const runtimes: RalphRuntimeHarness[] = [];

	afterEach(async () => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		for (const runtime of runtimes.splice(0)) {
			await runtime.dispose();
		}
	});

	it("resolves loop ownership from session file for before_agent_start and ralph_done", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const context = makeContext(cwd, [{ cancelled: false }]);
		const iterationSession = path.join(cwd, ".pi", "sessions", "iteration-owned.session.json");
		context.setSessionFile(iterationSession);

		writeLoopState(cwd, "owned-loop", {
			controllerSessionFile: path.join(cwd, ".pi", "sessions", "controller-owned.session.json"),
			activeIterationSessionFile: iterationSession,
			iteration: 3,
			status: "active",
		});

		const piHarness = makePiHarness();
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);
		initRalph(piHarness.pi, ralphRuntime.run);

		const beforeStartResults = await piHarness.fire(
			"before_agent_start",
			{
				type: "before_agent_start",
				prompt: "continue",
				systemPrompt: "base",
			},
			context.ctx,
		);

		expect(beforeStartResults[0]).toEqual({
			systemPrompt: expect.stringContaining("[RALPH LOOP - owned-loop - Iteration 3/50]"),
		});

		const doneTool = piHarness.tools.get("ralph_done");
		expect(doneTool).toBeDefined();
		const doneResult = (await doneTool?.execute(
			"call-owned",
			{},
			undefined,
			undefined,
			context.ctx,
		)) as ToolExecutionResult;

		expect(doneResult.content[0]?.text).toContain("Iteration 3 complete. Finalize recorded.");
		const state = readLoopState(cwd, "owned-loop");
		expect(state.awaitingFinalize).toBe(true);
		expect(Option.isSome(state.advanceRequestedAt)).toBe(true);
	});

	it("closes an active owned loop when completion marker appears in agent_end", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const context = makeContext(cwd, [{ cancelled: false }]);
		const iterationSession = path.join(cwd, ".pi", "sessions", "iteration-done.session.json");
		context.setSessionFile(iterationSession);

		writeLoopState(cwd, "close-loop", {
			controllerSessionFile: path.join(cwd, ".pi", "sessions", "controller-close.session.json"),
			activeIterationSessionFile: iterationSession,
			iteration: 5,
			status: "active",
		});

		const piHarness = makePiHarness();
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);
		initRalph(piHarness.pi, ralphRuntime.run);

		await piHarness.fire(
			"agent_end",
			agentEndPayload("final response <promise>COMPLETE</promise>"),
			context.ctx,
		);

		const state = readLoopState(cwd, "close-loop");
		expect(state.status).toBe("completed");
		expect(Option.isSome(state.completedAt)).toBe(true);
		expect(piHarness.sentUserMessages).toHaveLength(1);
		const banner = piHarness.sentUserMessages[0]?.content;
		expect(typeof banner === "string" ? banner : "").toContain("RALPH LOOP COMPLETE");
	});

	it("reports persisted-state decode failures during session events instead of throwing", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const context = makeContext(cwd);
		const invalidStatePath = loopStatePath(cwd, "broken-loop");
		fs.mkdirSync(path.dirname(invalidStatePath), { recursive: true });
		fs.writeFileSync(
			invalidStatePath,
			JSON.stringify(
				{
					name: "broken-loop",
					taskFile: ".pi/ralph/tasks/broken-loop.md",
					iteration: 1,
					maxIterations: 10,
					itemsPerIteration: 0,
					reflectEvery: 0,
					reflectInstructions: "reflect",
					status: "invalid-status",
					startedAt: "2026-01-01T00:00:00.000Z",
					completedAt: null,
					lastReflectionAt: 0,
					controllerSessionFile: null,
					activeIterationSessionFile: null,
					advanceRequestedAt: null,
					awaitingFinalize: false,
				},
				null,
				2,
			),
			"utf-8",
		);

		const piHarness = makePiHarness();
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);
		initRalph(piHarness.pi, ralphRuntime.run);

		await expect(
			piHarness.fire("session_start", { type: "session_start" }, context.ctx),
		).resolves.toBeDefined();
		expect(
			context.notifications.some((entry) => entry.message.includes("Ralph state is invalid")),
		).toBe(true);
	});

	it("keeps the Ralph widget visible on session_start while a current loop is active", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const context = makeContext(cwd);
		const controllerSession = context.getSessionFile();
		const unrelatedSession = path.join(cwd, ".pi", "sessions", "other.session.json");
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);

		await ralphRuntime.run(
			Effect.gen(function* () {
				const ralph = yield* Ralph;
				yield* ralph.startLoopState(cwd, {
					loopName: "ui-loop",
					taskFile: path.join(".pi", "ralph", "tasks", "ui-loop.md"),
					maxIterations: 50,
					itemsPerIteration: 0,
					reflectEvery: 0,
					reflectInstructions: "reflect",
					controllerSessionFile: Option.some(controllerSession),
					defaultTaskTemplate: "# Task\n",
				});
			}),
		);

		context.setSessionFile(unrelatedSession);
		const piHarness = makePiHarness();
		initRalph(piHarness.pi, ralphRuntime.run);

		await piHarness.fire("session_start", { type: "session_start" }, context.ctx);

		expect(context.widgetUpdates.at(-1)).toEqual(
			expect.arrayContaining(["Ralph Wiggum", "Loop: ui-loop"]),
		);
		expect(context.statusUpdates.at(-1)).toContain("ui-loop");
	});

	it("keeps session actions command-owned: tools/events do not call newSession or switchSession", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const context = makeContext(cwd, [
			{ cancelled: true },
			{ cancelled: true },
		]);
		const piHarness = makePiHarness();
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);
		initRalph(piHarness.pi, ralphRuntime.run);

		const startTool = piHarness.tools.get("ralph_start");
		const doneTool = piHarness.tools.get("ralph_done");
		const command = piHarness.commands.get("ralph");
		expect(startTool).toBeDefined();
		expect(doneTool).toBeDefined();
		expect(command).toBeDefined();

		const activeOwnedSession = context.getSessionFile();
		writeLoopState(cwd, "tool-owned-loop", {
			controllerSessionFile: path.join(cwd, ".pi", "sessions", "controller-tool-owned.session.json"),
			activeIterationSessionFile: activeOwnedSession,
			iteration: 7,
			status: "active",
		});

		await startTool?.execute(
			"call-start",
			{
				name: "tool-loop",
				taskContent: "# Task\n- via tool\n",
			},
			undefined,
			undefined,
			context.ctx,
		);

		const doneResult = (await doneTool?.execute(
			"call-done",
			{},
			undefined,
			undefined,
			context.ctx,
		)) as ToolExecutionResult;
		expect(doneResult.content[0]?.text).toContain("Iteration 7 complete. Finalize recorded.");

		const activeDoneState = readLoopState(cwd, "tool-owned-loop");
		expect(activeDoneState.status).toBe("active");
		expect(activeDoneState.awaitingFinalize).toBe(true);
		expect(Option.isSome(activeDoneState.advanceRequestedAt)).toBe(true);

		await piHarness.fire(
			"before_agent_start",
			{
				type: "before_agent_start",
				prompt: "test",
				systemPrompt: "base",
			},
			context.ctx,
		);

		await piHarness.fire("session_start", { type: "session_start" }, context.ctx);
		await piHarness.fire("session_switch", { type: "session_switch" }, context.ctx);
		await piHarness.fire("session_shutdown", { type: "session_shutdown" }, context.ctx);

		expect(context.newSessionCalls).toHaveLength(0);
		expect(context.switchSessionCalls).toHaveLength(0);

		await command?.handler("start command-loop", context.ctx);
		expect(context.newSessionCalls).toHaveLength(1);

		const controllerSession = Option.getOrUndefined(
			readLoopState(cwd, "command-loop").controllerSessionFile,
		);
		if (!controllerSession) {
			throw new Error("missing controller session");
		}
		context.setSessionFile(path.join(cwd, ".pi", "sessions", "other.session.json"));

		await command?.handler("resume command-loop", context.ctx);
		expect(context.switchSessionCalls).toContain(controllerSession);
	});

	it("does not double-escape backslashes in create command hints for Windows paths", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const context = makeContext(cwd);
		const piHarness = makePiHarness();
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);
		initRalph(piHarness.pi, ralphRuntime.run);

		const command = piHarness.commands.get("ralph");
		expect(command).toBeDefined();
		await command?.handler("create C:\\Users\\name\\My Documents\\task.md", context.ctx);

		const sent = piHarness.sentUserMessages[0]?.content;
		const text = typeof sent === "string" ? sent : "";
		expect(text).toContain('/ralph start "C:\\Users\\name\\My Documents\\task.md"');
		expect(text).not.toContain("\\\\");
	});
});
