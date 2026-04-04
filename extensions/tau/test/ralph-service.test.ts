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

type Notifications = Array<{ readonly message: string; readonly level: string }>;

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

type RalphRuntimeHarness = {
	readonly run: <A, E>(effect: Effect.Effect<A, E, Ralph>) => Promise<A>;
	readonly dispose: () => Promise<void>;
};

type ContextHarness = {
	readonly ctx: ExtensionCommandContext;
	readonly notifications: Notifications;
	readonly newSessionCalls: ReadonlyArray<unknown>;
	readonly switchSessionCalls: readonly string[];
	readonly setSessionFile: (next: string) => void;
	readonly getSessionFile: () => string;
};

type PiHarness = {
	readonly pi: ExtensionAPI;
	readonly commands: Map<string, RegisteredCommand>;
	readonly tools: Map<string, ToolDefinition>;
	readonly sentUserMessages: SentUserMessage[];
	readonly fire: (event: string, payload: unknown, ctx: ExtensionContext) => Promise<void>;
};

type NewSessionPlan = {
	readonly cancelled: boolean;
	readonly sessionFile?: string;
};

type LoopStatus = "active" | "paused" | "completed";

function makeRalphRuntime(activeSubagents: boolean): RalphRuntimeHarness {
	const layer = RalphLive({
		hasActiveSubagents: () => Effect.succeed(activeSubagents),
	}).pipe(Layer.provideMerge(RalphRepoLive), Layer.provide(NodeFileSystem.layer));
	const runtime = ManagedRuntime.make(layer);
	return {
		run: (effect) => runtime.runPromise(effect),
		dispose: () => runtime.dispose(),
	};
}

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tau-ralph-service-"));
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
		readonly status?: LoopStatus;
		readonly iteration?: number;
		readonly controllerSessionFile: string;
		readonly activeIterationSessionFile?: string;
		readonly awaitingFinalize?: boolean;
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
			awaitingFinalize: input.awaitingFinalize ?? false,
		}),
		"utf-8",
	);
}

function makeContext(
	cwd: string,
	newSessionPlan: readonly NewSessionPlan[] = [{ cancelled: false }],
): ContextHarness {
	const notifications: Notifications = [];
	const newSessionCalls: unknown[] = [];
	const switchSessionCalls: string[] = [];
	let sessionFile = path.join(cwd, ".pi", "sessions", "controller.session.json");
	let sessionCounter = 0;

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
			setStatus: () => undefined,
			setWidget: () => undefined,
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
			const plan = newSessionPlan[sessionCounter] ?? { cancelled: false };
			sessionCounter += 1;
			if (!plan.cancelled) {
				sessionFile =
					plan.sessionFile ??
					path.join(cwd, ".pi", "sessions", `child-${sessionCounter}.session.json`);
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
			for (const handler of eventHandlers.get(event) ?? []) {
				await Promise.resolve(handler(payload, ctx));
			}
		},
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 80; attempt += 1) {
		if (predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("timed out waiting for condition");
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

describe("ralph service behavior freeze", () => {
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

	it("resumes a paused loop and honors the ralph_done finalize handshake", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const piHarness = makePiHarness();
		const ralphRuntime = makeRalphRuntime(false);
		runtimes.push(ralphRuntime);
		initRalph(piHarness.pi, ralphRuntime.run);

		const command = piHarness.commands.get("ralph");
		const doneTool = piHarness.tools.get("ralph_done");
		expect(command).toBeDefined();
		expect(doneTool).toBeDefined();

		const context = makeContext(cwd, [
			{ cancelled: false },
			{ cancelled: false },
			{ cancelled: true },
		]);

		const startPromise = command?.handler("start resume-loop", context.ctx);
		await waitFor(() => piHarness.sentUserMessages.length === 1);

		await piHarness.fire("agent_end", agentEndPayload("worked but no done"), context.ctx);
		await startPromise;

		const afterFirstIteration = readLoopState(cwd, "resume-loop");
		expect(afterFirstIteration.status).toBe("paused");
		expect(afterFirstIteration.iteration).toBe(1);
		expect(afterFirstIteration.awaitingFinalize).toBe(false);

		const resumePromise = command?.handler("resume resume-loop", context.ctx);
		await waitFor(() => piHarness.sentUserMessages.length === 2);

		const doneResult = (await doneTool?.execute(
			"call-1",
			{},
			undefined,
			undefined,
			context.ctx,
		)) as ToolExecutionResult;

		expect(doneResult.content[0]?.text).toContain("Iteration 2 complete. Finalize recorded.");

		const afterDone = readLoopState(cwd, "resume-loop");
		expect(afterDone.awaitingFinalize).toBe(true);
		expect(Option.isSome(afterDone.advanceRequestedAt)).toBe(true);

		await piHarness.fire("agent_end", agentEndPayload("continue"), context.ctx);
		await resumePromise;

		const finalState = readLoopState(cwd, "resume-loop");
		expect(finalState.status).toBe("paused");
		expect(finalState.iteration).toBe(2);
		expect(finalState.awaitingFinalize).toBe(false);
		expect(context.newSessionCalls).toHaveLength(3);
		expect(context.notifications.some((entry) => entry.message.includes("Resuming: resume-loop"))).toBe(true);
	});

	it("pauses /ralph start when subagents are active before creating the next iteration", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const piHarness = makePiHarness();
		const ralphRuntime = makeRalphRuntime(true);
		runtimes.push(ralphRuntime);
		initRalph(piHarness.pi, ralphRuntime.run);

		const command = piHarness.commands.get("ralph");
		expect(command).toBeDefined();

		const context = makeContext(cwd, [{ cancelled: false }]);
		await command?.handler("start blocked-on-start", context.ctx);

		const state = readLoopState(cwd, "blocked-on-start");
		expect(state.status).toBe("paused");
		expect(state.iteration).toBe(0);
		expect(state.awaitingFinalize).toBe(true);
		expect(context.newSessionCalls).toHaveLength(0);
		expect(context.notifications.some((entry) => entry.message.includes("subagents became active"))).toBe(true);
	});

	it("pauses /ralph resume when finalize is pending and subagents are still active", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const context = makeContext(cwd, [{ cancelled: false }]);
		const staleIterationSession = path.join(cwd, ".pi", "sessions", "stale-iteration.session.json");
		writeLoopState(cwd, "blocked-on-resume", {
			controllerSessionFile: context.getSessionFile(),
			activeIterationSessionFile: staleIterationSession,
			iteration: 6,
			status: "paused",
			awaitingFinalize: true,
		});

		const piHarness = makePiHarness();
		const ralphRuntime = makeRalphRuntime(true);
		runtimes.push(ralphRuntime);
		initRalph(piHarness.pi, ralphRuntime.run);

		const command = piHarness.commands.get("ralph");
		expect(command).toBeDefined();

		await command?.handler("resume blocked-on-resume", context.ctx);

		const state = readLoopState(cwd, "blocked-on-resume");
		expect(state.status).toBe("paused");
		expect(state.iteration).toBe(6);
		expect(state.awaitingFinalize).toBe(true);
		expect(Option.isNone(state.activeIterationSessionFile)).toBe(true);
		expect(context.newSessionCalls).toHaveLength(0);
		expect(context.switchSessionCalls).toHaveLength(0);
		expect(context.notifications.some((entry) => entry.message.includes("subagents are still active"))).toBe(true);
	});

	it("blocks ralph_done advancement while subagents are active", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const context = makeContext(cwd, [{ cancelled: false }]);
		writeLoopState(cwd, "blocked-loop", {
			controllerSessionFile: context.getSessionFile(),
			activeIterationSessionFile: context.getSessionFile(),
			iteration: 4,
			status: "active",
		});

		const piHarness = makePiHarness();
		const ralphRuntime = makeRalphRuntime(true);
		runtimes.push(ralphRuntime);
		initRalph(piHarness.pi, ralphRuntime.run);

		const doneTool = piHarness.tools.get("ralph_done");
		expect(doneTool).toBeDefined();

		const result = (await doneTool?.execute(
			"call-2",
			{},
			undefined,
			undefined,
			context.ctx,
		)) as ToolExecutionResult;

		expect(result.content[0]?.text).toContain("Subagents are still active");

		const state = readLoopState(cwd, "blocked-loop");
		expect(state.status).toBe("paused");
		expect(state.awaitingFinalize).toBe(true);
		expect(Option.isSome(state.advanceRequestedAt)).toBe(true);
		expect(Option.isNone(state.activeIterationSessionFile)).toBe(true);
	});

	it("marks the loop completed when the completion marker appears", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const piHarness = makePiHarness();
		const ralphRuntime = makeRalphRuntime(false);
		runtimes.push(ralphRuntime);
		initRalph(piHarness.pi, ralphRuntime.run);
		const command = piHarness.commands.get("ralph");
		expect(command).toBeDefined();

		const context = makeContext(cwd, [{ cancelled: false }]);
		const startPromise = command?.handler("start complete-loop", context.ctx);
		await waitFor(() => piHarness.sentUserMessages.length === 1);

		await piHarness.fire(
			"agent_end",
			agentEndPayload("done now <promise>COMPLETE</promise>"),
			context.ctx,
		);
		await startPromise;

		const state = readLoopState(cwd, "complete-loop");
		expect(state.status).toBe("completed");
		expect(Option.isSome(state.completedAt)).toBe(true);
		expect(piHarness.sentUserMessages).toHaveLength(2);
		const banner = piHarness.sentUserMessages[1]?.content;
		expect(typeof banner === "string" ? banner : "").toContain("RALPH LOOP COMPLETE");
	});
});
