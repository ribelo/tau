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
import { decodeLoopStateSync } from "../src/ralph/schema.js";
import {
	decodeLoopPersistedStateJsonSync,
	encodeLoopPersistedStateJsonSync,
} from "../src/loops/schema.js";
import { LoopRepoLive } from "../src/loops/repo.js";
import { LoopEngineLive } from "../src/services/loop-engine.js";
import { PromptModes } from "../src/services/prompt-modes.js";
import { Ralph, RalphLive } from "../src/services/ralph.js";
import { makeExecutionProfile, makePromptModesStubLayer } from "./ralph-test-helpers.js";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

type RegisteredCommand = {
	readonly handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
};

type Notifications = Array<{ readonly message: string; readonly level: string }>;
type SentUserMessage = {
	readonly prompt: string;
	readonly options: { readonly deliverAs?: string } | undefined;
};

type RalphRuntimeHarness = {
	readonly run: <A, E>(effect: Effect.Effect<A, E, Ralph | PromptModes>) => Promise<A>;
	readonly dispose: () => Promise<void>;
};

function makeRalphRuntime(activeSubagents = false): RalphRuntimeHarness {
	const layer = RalphLive({
		hasActiveSubagents: () => Effect.succeed(activeSubagents),
	}).pipe(
		Layer.provideMerge(RalphRepoLive),
		Layer.provideMerge(LoopEngineLive.pipe(Layer.provideMerge(LoopRepoLive))),
		Layer.provideMerge(makePromptModesStubLayer()),
		Layer.provide(NodeFileSystem.layer),
	);
	const runtime = ManagedRuntime.make(layer);
	return {
		run: (effect) => runtime.runPromise(effect),
		dispose: () => runtime.dispose(),
	};
}

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tau-ralph-store-"));
}

function statePath(cwd: string, name: string, archived = false): string {
	return archived
		? path.join(cwd, ".pi", "loops", "archive", "state", `${name}.json`)
		: path.join(cwd, ".pi", "loops", "state", `${name}.json`);
}

function taskPath(cwd: string, name: string, archived = false): string {
	return archived
		? path.join(cwd, ".pi", "loops", "archive", "tasks", `${name}.md`)
		: path.join(cwd, ".pi", "loops", "tasks", `${name}.md`);
}

type ParsedLoopState = ReturnType<typeof decodeLoopStateSync>;

function statusToLifecycle(status: ParsedLoopState["status"]): "active" | "paused" | "completed" {
	if (status === "active") {
		return "active";
	}
	if (status === "paused") {
		return "paused";
	}
	return "completed";
}

function lifecycleToStatus(
	lifecycle: "draft" | "active" | "paused" | "completed" | "archived",
): ParsedLoopState["status"] {
	if (lifecycle === "active") {
		return "active";
	}
	if (lifecycle === "paused" || lifecycle === "draft") {
		return "paused";
	}
	return "completed";
}

function encodeStateForStorage(state: ParsedLoopState): string {
	return encodeLoopPersistedStateJsonSync({
		taskId: state.name,
		title: state.name,
		taskFile: state.taskFile,
		kind: "ralph",
		lifecycle: statusToLifecycle(state.status),
		createdAt: state.startedAt,
		updatedAt: state.startedAt,
		startedAt: Option.some(state.startedAt),
		completedAt: state.completedAt,
		archivedAt: Option.none(),
		ownership: {
			controller: Option.match(state.controllerSessionFile, {
				onNone: () => Option.none(),
				onSome: (sessionFile) => Option.some({ sessionId: sessionFile, sessionFile }),
			}),
			child: Option.match(state.activeIterationSessionFile, {
				onNone: () => Option.none(),
				onSome: (sessionFile) => Option.some({ sessionId: sessionFile, sessionFile }),
			}),
		},
		ralph: {
			iteration: state.iteration,
			maxIterations: state.maxIterations,
			itemsPerIteration: state.itemsPerIteration,
			reflectEvery: state.reflectEvery,
			reflectInstructions: state.reflectInstructions,
			lastReflectionAt: state.lastReflectionAt,
			pendingDecision: state.pendingDecision,
			pinnedExecutionProfile: state.executionProfile,
		},
	});
}

function readState(cwd: string, name: string, archived = false) {
	const state = decodeLoopPersistedStateJsonSync(
		fs.readFileSync(statePath(cwd, name, archived), "utf-8"),
	);
	if (state.kind !== "ralph") {
		throw new Error(`Expected ralph state for ${name}, got ${state.kind}`);
	}
	return {
		name: state.taskId,
		taskFile: state.taskFile,
		iteration: state.ralph.iteration,
		maxIterations: state.ralph.maxIterations,
		itemsPerIteration: state.ralph.itemsPerIteration,
		reflectEvery: state.ralph.reflectEvery,
		reflectInstructions: state.ralph.reflectInstructions,
		status: lifecycleToStatus(state.lifecycle),
		startedAt: Option.getOrElse(state.startedAt, () => state.createdAt),
		completedAt: state.completedAt,
		lastReflectionAt: state.ralph.lastReflectionAt,
		controllerSessionFile: Option.map(state.ownership.controller, (controller) => controller.sessionFile),
		activeIterationSessionFile: Option.map(state.ownership.child, (child) => child.sessionFile),
		pendingDecision: state.ralph.pendingDecision,
		executionProfile: state.ralph.pinnedExecutionProfile,
	};
}

function makeContext(
	cwd: string,
	notifications: Notifications,
	newSessionCancelled: readonly boolean[] = [true],
	options?: { readonly idle?: boolean; readonly sessionFile?: string },
): ExtensionCommandContext {
	let sessionFile = options?.sessionFile ?? path.join(cwd, ".pi", "sessions", "controller.session.json");
	let newSessionCount = 0;
	const idle = options?.idle ?? true;

	const context = {
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
		isIdle: () => idle,
		abort: () => undefined,
		hasPendingMessages: () => false,
		shutdown: () => undefined,
		getContextUsage: () => undefined,
		compact: () => undefined,
		getSystemPrompt: () => "",
		waitForIdle: async () => undefined,
		newSession: async () => {
			const cancelled = newSessionCancelled[newSessionCount] ?? false;
			newSessionCount += 1;
			if (!cancelled) {
				sessionFile = path.join(cwd, ".pi", "sessions", `child-${newSessionCount}.session.json`);
			}
			return { cancelled };
		},
		fork: async () => ({ cancelled: false }),
		navigateTree: async () => ({ cancelled: false }),
		switchSession: async (target: string) => {
			sessionFile = target;
			return { cancelled: false };
		},
		reload: async () => undefined,
	} as unknown as ExtensionCommandContext;

	return context;
}

function makePiStub(): {
	readonly pi: ExtensionAPI;
	readonly commands: Map<string, RegisteredCommand>;
	readonly tools: ToolDefinition[];
	readonly sentUserMessages: SentUserMessage[];
} {
	const eventHandlers = new Map<string, EventHandler[]>();
	const commands = new Map<string, RegisteredCommand>();
	const tools: ToolDefinition[] = [];
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
			tools.push(tool);
		},
		registerShortcut: () => undefined,
		registerFlag: () => undefined,
		registerMessageRenderer: () => undefined,
		sendUserMessage: (prompt: string, options?: { readonly deliverAs?: string }) => {
			sentUserMessages.push({ prompt, options });
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

describe("ralph store behavior freeze", () => {
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

	it("/ralph start creates task and state files before the loop pauses", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const notifications: Notifications = [];
		const { pi, commands } = makePiStub();
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);
		initRalph(pi, ralphRuntime.run);

		const command = commands.get("ralph");
		expect(command).toBeDefined();

		const context = makeContext(cwd, notifications, [true]);
		await command?.handler("start alpha-loop", context);
		await waitFor(() => readState(cwd, "alpha-loop").status === "paused");

		expect(fs.existsSync(taskPath(cwd, "alpha-loop"))).toBe(true);
		expect(fs.existsSync(statePath(cwd, "alpha-loop"))).toBe(true);

		const state = readState(cwd, "alpha-loop");
		expect(state.taskFile).toBe(path.join(".pi", "loops", "tasks", "alpha-loop.md"));
		expect(state.iteration).toBe(0);
		expect(state.status).toBe("paused");
		expect(Option.getOrUndefined(state.controllerSessionFile)).toContain("controller.session.json");
		expect(fs.readFileSync(taskPath(cwd, "alpha-loop"), "utf-8")).toContain("# Task");
		expect(notifications.some((entry) => entry.message.includes("Started loop \"alpha-loop\""))).toBe(true);
	});

	it("/ralph start rejects extra positional arguments instead of starting the wrong loop", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const notifications: Notifications = [];
		const { pi, commands } = makePiStub();
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);
		initRalph(pi, ralphRuntime.run);

		const command = commands.get("ralph");
		expect(command).toBeDefined();

		const context = makeContext(cwd, notifications, [true]);
		await command?.handler("start erg-9iks --max-iterations 12 --items-per-iteration 2 2", context);

		expect(fs.existsSync(taskPath(cwd, "erg-9iks"))).toBe(false);
		expect(fs.existsSync(taskPath(cwd, "2"))).toBe(false);
		expect(
			notifications.some((entry) => entry.message.includes("unexpected extra argument \"2\"")),
		).toBe(true);
	});

	it("/ralph start rejects unknown options instead of reinterpreting their values as loop names", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const notifications: Notifications = [];
		const { pi, commands } = makePiStub();
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);
		initRalph(pi, ralphRuntime.run);

		const command = commands.get("ralph");
		expect(command).toBeDefined();

		const context = makeContext(cwd, notifications, [true]);
		await command?.handler("start erg-9iks --max-iterations 12 --itemsPerIteration 2", context);

		expect(fs.existsSync(taskPath(cwd, "erg-9iks"))).toBe(false);
		expect(fs.existsSync(taskPath(cwd, "2"))).toBe(false);
		expect(
			notifications.some((entry) => entry.message.includes("unknown option \"--itemsPerIteration\"")),
		).toBe(true);
	});

	it("/ralph resume warns when the loop is paused at the max-iterations cap", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const notifications: Notifications = [];
		const { pi, commands } = makePiStub();
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);
		initRalph(pi, ralphRuntime.run);

		const command = commands.get("ralph");
		expect(command).toBeDefined();

		fs.mkdirSync(path.join(cwd, ".pi", "loops", "state"), { recursive: true });
		fs.writeFileSync(
			statePath(cwd, "limit-loop"),
			encodeStateForStorage(
				decodeLoopStateSync({
					name: "limit-loop",
					taskFile: path.join(".pi", "loops", "tasks", "limit-loop.md"),
					iteration: 12,
					maxIterations: 12,
					itemsPerIteration: 0,
					reflectEvery: 0,
					reflectInstructions: "reflect",
					status: "paused",
					startedAt: "2026-01-01T00:00:00.000Z",
					completedAt: null,
					lastReflectionAt: 0,
					controllerSessionFile: path.join(cwd, ".pi", "sessions", "controller.session.json"),
					activeIterationSessionFile: null,
					pendingDecision: null,
					executionProfile: makeExecutionProfile(),
				}),
			),
			"utf-8",
		);

		const context = makeContext(cwd, notifications);
		await command?.handler("resume limit-loop", context);

		const state = readState(cwd, "limit-loop");
		expect(state.status).toBe("paused");
		expect(state.iteration).toBe(12);
		expect(state.maxIterations).toBe(12);
		expect(
			notifications.some((entry) =>
				entry.message.includes(
					'Loop "limit-loop" reached max iterations (12/12). Resume with /ralph resume limit-loop --max-iterations 13 (or higher).',
				),
			),
		).toBe(true);
	});

	it("/ralph resume --max-iterations raises the cap in place without resetting iteration", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const notifications: Notifications = [];
		const { pi, commands } = makePiStub();
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);
		initRalph(pi, ralphRuntime.run);

		const command = commands.get("ralph");
		expect(command).toBeDefined();

		fs.mkdirSync(path.join(cwd, ".pi", "loops", "state"), { recursive: true });
		fs.writeFileSync(
			statePath(cwd, "limit-loop"),
			encodeStateForStorage(
				decodeLoopStateSync({
					name: "limit-loop",
					taskFile: path.join(".pi", "loops", "tasks", "limit-loop.md"),
					iteration: 12,
					maxIterations: 12,
					itemsPerIteration: 0,
					reflectEvery: 0,
					reflectInstructions: "reflect",
					status: "paused",
					startedAt: "2026-01-01T00:00:00.000Z",
					completedAt: null,
					lastReflectionAt: 0,
					controllerSessionFile: path.join(cwd, ".pi", "sessions", "controller.session.json"),
					activeIterationSessionFile: null,
					pendingDecision: null,
					executionProfile: makeExecutionProfile(),
				}),
			),
			"utf-8",
		);

		const context = makeContext(cwd, notifications);
		await command?.handler("resume limit-loop --max-iterations 24", context);
		await waitFor(() => readState(cwd, "limit-loop").status === "paused");

		const state = readState(cwd, "limit-loop");
		expect(state.status).toBe("paused");
		expect(state.iteration).toBe(12);
		expect(state.maxIterations).toBe(24);
		expect(notifications.some((entry) => entry.message.includes("Resuming: limit-loop"))).toBe(true);
	});

	it("/ralph resume reopens completed loops without iteration reset", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const notifications: Notifications = [];
		const { pi, commands } = makePiStub();
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);
		initRalph(pi, ralphRuntime.run);

		const command = commands.get("ralph");
		expect(command).toBeDefined();

		fs.mkdirSync(path.join(cwd, ".pi", "loops", "state"), { recursive: true });
		fs.writeFileSync(
			statePath(cwd, "done-loop"),
			encodeStateForStorage(
				decodeLoopStateSync({
					name: "done-loop",
					taskFile: path.join(".pi", "loops", "tasks", "done-loop.md"),
					iteration: 9,
					maxIterations: 12,
					itemsPerIteration: 0,
					reflectEvery: 0,
					reflectInstructions: "reflect",
					status: "completed",
					startedAt: "2026-01-01T00:00:00.000Z",
					completedAt: "2026-01-01T02:00:00.000Z",
					lastReflectionAt: 0,
					controllerSessionFile: path.join(cwd, ".pi", "sessions", "controller.session.json"),
					activeIterationSessionFile: null,
					pendingDecision: null,
					executionProfile: makeExecutionProfile(),
				}),
			),
			"utf-8",
		);

		const context = makeContext(cwd, notifications);
		await command?.handler("resume done-loop", context);
		await waitFor(() => readState(cwd, "done-loop").status === "paused");

		const state = readState(cwd, "done-loop");
		expect(state.status).toBe("paused");
		expect(state.iteration).toBe(9);
		expect(state.maxIterations).toBe(12);
		expect(Option.isNone(state.completedAt)).toBe(true);
		expect(notifications.some((entry) => entry.message.includes("Resuming: done-loop"))).toBe(true);
		expect(
			notifications.some((entry) => entry.message.includes('Loop "done-loop" is completed.')),
		).toBe(false);
	});

	it("/ralph resume treats legacy completed-at-cap loops as max-iterations reached", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const notifications: Notifications = [];
		const { pi, commands } = makePiStub();
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);
		initRalph(pi, ralphRuntime.run);

		const command = commands.get("ralph");
		expect(command).toBeDefined();

		fs.mkdirSync(path.join(cwd, ".pi", "loops", "state"), { recursive: true });
		fs.writeFileSync(
			statePath(cwd, "legacy-limit-loop"),
			encodeStateForStorage(
				decodeLoopStateSync({
					name: "legacy-limit-loop",
					taskFile: path.join(".pi", "loops", "tasks", "legacy-limit-loop.md"),
					iteration: 12,
					maxIterations: 12,
					itemsPerIteration: 0,
					reflectEvery: 0,
					reflectInstructions: "reflect",
					status: "completed",
					startedAt: "2026-01-01T00:00:00.000Z",
					completedAt: "2026-01-01T02:00:00.000Z",
					lastReflectionAt: 0,
					controllerSessionFile: path.join(cwd, ".pi", "sessions", "controller.session.json"),
					activeIterationSessionFile: null,
					pendingDecision: null,
					executionProfile: makeExecutionProfile(),
				}),
			),
			"utf-8",
		);

		const context = makeContext(cwd, notifications);
		await command?.handler("resume legacy-limit-loop", context);

		const state = readState(cwd, "legacy-limit-loop");
		expect(state.status).toBe("completed");
		expect(state.maxIterations).toBe(12);
		expect(
			notifications.some((entry) =>
				entry.message.includes(
					'Loop "legacy-limit-loop" reached max iterations (12/12). Resume with /ralph resume legacy-limit-loop --max-iterations 13 (or higher).',
				),
			),
		).toBe(true);
		expect(
			notifications.some((entry) => entry.message.includes('Loop "legacy-limit-loop" is completed.')),
		).toBe(false);
	});

	it("/ralph resume --max-iterations reopens legacy completed-at-cap loops without iteration reset", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const notifications: Notifications = [];
		const { pi, commands } = makePiStub();
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);
		initRalph(pi, ralphRuntime.run);

		const command = commands.get("ralph");
		expect(command).toBeDefined();

		fs.mkdirSync(path.join(cwd, ".pi", "loops", "state"), { recursive: true });
		fs.writeFileSync(
			statePath(cwd, "legacy-limit-loop"),
			encodeStateForStorage(
				decodeLoopStateSync({
					name: "legacy-limit-loop",
					taskFile: path.join(".pi", "loops", "tasks", "legacy-limit-loop.md"),
					iteration: 12,
					maxIterations: 12,
					itemsPerIteration: 0,
					reflectEvery: 0,
					reflectInstructions: "reflect",
					status: "completed",
					startedAt: "2026-01-01T00:00:00.000Z",
					completedAt: "2026-01-01T02:00:00.000Z",
					lastReflectionAt: 0,
					controllerSessionFile: path.join(cwd, ".pi", "sessions", "controller.session.json"),
					activeIterationSessionFile: null,
					pendingDecision: null,
					executionProfile: makeExecutionProfile(),
				}),
			),
			"utf-8",
		);

		const context = makeContext(cwd, notifications);
		await command?.handler("resume legacy-limit-loop --max-iterations 24", context);
		await waitFor(() => readState(cwd, "legacy-limit-loop").status === "paused");

		const state = readState(cwd, "legacy-limit-loop");
		expect(state.status).toBe("paused");
		expect(state.iteration).toBe(12);
		expect(state.maxIterations).toBe(24);
		expect(Option.isNone(state.completedAt)).toBe(true);
		expect(notifications.some((entry) => entry.message.includes("Resuming: legacy-limit-loop"))).toBe(true);
	});

	it("/ralph status distinguishes max-iterations stop from completed loops", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const notifications: Notifications = [];
		const { pi, commands } = makePiStub();
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);
		initRalph(pi, ralphRuntime.run);

		const command = commands.get("ralph");
		expect(command).toBeDefined();

		fs.mkdirSync(path.join(cwd, ".pi", "loops", "state"), { recursive: true });
		fs.writeFileSync(
			statePath(cwd, "limit-loop"),
			encodeStateForStorage(
				decodeLoopStateSync({
					name: "limit-loop",
					taskFile: path.join(".pi", "loops", "tasks", "limit-loop.md"),
					iteration: 12,
					maxIterations: 12,
					itemsPerIteration: 0,
					reflectEvery: 0,
					reflectInstructions: "reflect",
					status: "paused",
					startedAt: "2026-01-01T00:00:00.000Z",
					completedAt: null,
					lastReflectionAt: 0,
					controllerSessionFile: path.join(cwd, ".pi", "sessions", "controller.session.json"),
					activeIterationSessionFile: null,
					pendingDecision: null,
					executionProfile: makeExecutionProfile(),
				}),
			),
			"utf-8",
		);

		fs.writeFileSync(
			statePath(cwd, "done-loop"),
			encodeStateForStorage(
				decodeLoopStateSync({
					name: "done-loop",
					taskFile: path.join(".pi", "loops", "tasks", "done-loop.md"),
					iteration: 9,
					maxIterations: 12,
					itemsPerIteration: 0,
					reflectEvery: 0,
					reflectInstructions: "reflect",
					status: "completed",
					startedAt: "2026-01-01T00:00:00.000Z",
					completedAt: "2026-01-01T02:00:00.000Z",
					lastReflectionAt: 0,
					controllerSessionFile: path.join(cwd, ".pi", "sessions", "controller.session.json"),
					activeIterationSessionFile: null,
					pendingDecision: null,
					executionProfile: makeExecutionProfile(),
				}),
			),
			"utf-8",
		);

		const context = makeContext(cwd, notifications);
		await command?.handler("status", context);

		const statusMessage =
			notifications.find((entry) => entry.message.startsWith("Ralph loops:\n"))?.message ?? "";
		expect(statusMessage).toContain("limit-loop: ⚠ max iterations reached (iteration 12/12)");
		expect(statusMessage).toContain("done-loop: ✓ completed (iteration 9/12)");
	});

	it("/ralph create asks the current model to draft a backlog-based task file", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const notifications: Notifications = [];
		const { pi, commands, sentUserMessages } = makePiStub();
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);
		initRalph(pi, ralphRuntime.run);

		const command = commands.get("ralph");
		expect(command).toBeDefined();

		const context = makeContext(cwd, notifications);
		await command?.handler("create foo-31z", context);

		expect(sentUserMessages).toHaveLength(1);
		expect(sentUserMessages[0]?.prompt).toContain("Create a Ralph task file for `foo-31z`.");
		expect(sentUserMessages[0]?.prompt).toContain("backlog show foo-31z");
		expect(sentUserMessages[0]?.prompt).toContain(".pi/loops/tasks/foo-31z.md");
		expect(sentUserMessages[0]?.prompt).toContain("/ralph start foo-31z");
		expect(notifications.some((entry) => entry.message.includes("foo-31z.md"))).toBe(true);
	});

	it("/ralph create preserves dotted backlog ids in the task path and start hint", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const notifications: Notifications = [];
		const { pi, commands, sentUserMessages } = makePiStub();
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);
		initRalph(pi, ralphRuntime.run);

		const command = commands.get("ralph");
		expect(command).toBeDefined();

		const context = makeContext(cwd, notifications);
		await command?.handler("create tau-6vi.1", context);

		expect(sentUserMessages).toHaveLength(1);
		expect(sentUserMessages[0]?.prompt).toContain("If the target corresponds to a backlog item, inspect it first with `backlog show <id>`");
		expect(sentUserMessages[0]?.prompt).toContain(".pi/loops/tasks/tau-6vi.1.md");
		expect(sentUserMessages[0]?.prompt).toContain("/ralph start tau-6vi.1");
	});

	it("/ralph create recommends starting with the custom task path", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const notifications: Notifications = [];
		const { pi, commands, sentUserMessages } = makePiStub();
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);
		initRalph(pi, ralphRuntime.run);

		const command = commands.get("ralph");
		expect(command).toBeDefined();

		const context = makeContext(cwd, notifications);
		await command?.handler("create docs/tasks/refactor.md", context);

		expect(sentUserMessages).toHaveLength(1);
		expect(sentUserMessages[0]?.prompt).toContain("Write the task file at `docs/tasks/refactor.md`");
		expect(sentUserMessages[0]?.prompt).toContain("/ralph start docs/tasks/refactor.md");
	});

	it("/ralph create does not treat .md file paths as backlog ids", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const notifications: Notifications = [];
		const { pi, commands, sentUserMessages } = makePiStub();
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);
		initRalph(pi, ralphRuntime.run);

		const command = commands.get("ralph");
		expect(command).toBeDefined();

		const context = makeContext(cwd, notifications);
		await command?.handler("create foo-31z.md", context);

		expect(sentUserMessages).toHaveLength(1);
		expect(sentUserMessages[0]?.prompt).toContain("Write the task file at `foo-31z.md`");
		expect(sentUserMessages[0]?.prompt).not.toContain("backlog show foo-31z.md");
		expect(sentUserMessages[0]?.prompt).toContain("/ralph start foo-31z.md");
	});

	it("/ralph create quotes custom start hints for paths with spaces", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const notifications: Notifications = [];
		const { pi, commands, sentUserMessages } = makePiStub();
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);
		initRalph(pi, ralphRuntime.run);

		const command = commands.get("ralph");
		expect(command).toBeDefined();

		const context = makeContext(cwd, notifications);
		await command?.handler("create docs/tasks/my task.md", context);

		expect(sentUserMessages).toHaveLength(1);
		expect(sentUserMessages[0]?.prompt).toContain('/ralph start "docs/tasks/my task.md"');
	});

	it("/ralph create strips surrounding quotes from backlog ids and paths", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const notifications: Notifications = [];
		const { pi, commands, sentUserMessages } = makePiStub();
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);
		initRalph(pi, ralphRuntime.run);

		const command = commands.get("ralph");
		expect(command).toBeDefined();

		const context = makeContext(cwd, notifications);
		await command?.handler('create "tau-6vi.1"', context);
		await command?.handler('create "docs/tasks/my task.md"', context);

		expect(sentUserMessages).toHaveLength(2);
		expect(sentUserMessages[0]?.prompt).toContain("Create a Ralph task file for `tau-6vi.1`.");
		expect(sentUserMessages[0]?.prompt).toContain("Example backlog flow: `/ralph create foo-31z` should inspect `backlog show foo-31z`");
		expect(sentUserMessages[1]?.prompt).toContain("Write the task file at `docs/tasks/my task.md`");
		expect(sentUserMessages[1]?.prompt).toContain('/ralph start "docs/tasks/my task.md"');
	});

	it("/ralph create treats free-form requests as task descriptions and asks the model to choose a short name", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const notifications: Notifications = [];
		const { pi, commands, sentUserMessages } = makePiStub();
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);
		initRalph(pi, ralphRuntime.run);

		const command = commands.get("ralph");
		expect(command).toBeDefined();

		const context = makeContext(cwd, notifications);
		await command?.handler("create my-feature", context);

		expect(sentUserMessages).toHaveLength(1);
		expect(sentUserMessages[0]?.prompt).toContain("Create a Ralph task file for this request:");
		expect(sentUserMessages[0]?.prompt).toContain("`my-feature`");
		expect(sentUserMessages[0]?.prompt).toContain("Pick the best short name for the loop and task file.");
		expect(sentUserMessages[0]?.prompt).toContain("Do not mirror the full request text into the file name.");
		expect(sentUserMessages[0]?.prompt).not.toContain("backlog show my-feature");
		expect(sentUserMessages[0]?.prompt).not.toContain(".pi/loops/tasks/my-feature.md");
		expect(sentUserMessages[0]?.prompt).not.toContain("/ralph start my-feature");
		expect(notifications.some((entry) => entry.message.includes("choose a short name"))).toBe(true);
	});

	it("/ralph create does not turn long free-form requests into long task file paths", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const notifications: Notifications = [];
		const { pi, commands, sentUserMessages } = makePiStub();
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);
		initRalph(pi, ralphRuntime.run);

		const command = commands.get("ralph");
		expect(command).toBeDefined();

		const context = makeContext(cwd, notifications);
		await command?.handler(
			"create make ralph task from all still open tasks you listed in previous message",
			context,
		);

		expect(sentUserMessages).toHaveLength(1);
		expect(sentUserMessages[0]?.prompt).toContain("Pick the best short name for the loop and task file.");
		expect(sentUserMessages[0]?.prompt).toContain("Write the task file at `.pi/loops/tasks/<chosen-name>.md` using apply_patch.");
		expect(sentUserMessages[0]?.prompt).not.toContain(
			".pi/loops/tasks/make_ralph_task_from_all_still_open_tasks_you_listed_in_previous_message.md",
		);
	});

	it("/ralph stop ends the active loop and /ralph pause keeps it resumable", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);
		const controllerSessionFile = path.join(cwd, ".pi", "sessions", "controller.session.json");

		const notifications: Notifications = [];
		const { pi, commands } = makePiStub();
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);
		initRalph(pi, ralphRuntime.run);

		const command = commands.get("ralph");
		expect(command).toBeDefined();

		await ralphRuntime.run(
			Effect.gen(function* () {
				const ralph = yield* Ralph;
					yield* ralph.startLoopState(cwd, {
						loopName: "pausable-loop",
						taskFile: path.join(".pi", "loops", "tasks", "pausable-loop.md"),
						executionProfile: makeExecutionProfile(),
						maxIterations: 50,
					itemsPerIteration: 0,
					reflectEvery: 0,
					reflectInstructions: "reflect",
					controllerSessionFile: Option.some(controllerSessionFile),
					defaultTaskTemplate: "# Task\n",
				});
			})
		);

		const context = makeContext(cwd, notifications);
		await command?.handler("pause", context);

		const pausedState = readState(cwd, "pausable-loop");
		expect(pausedState.status).toBe("paused");
		expect(notifications.some((entry) => entry.message.includes("Paused Ralph loop: pausable-loop"))).toBe(true);

		await ralphRuntime.run(
			Effect.gen(function* () {
				const ralph = yield* Ralph;
				yield* ralph.resumeLoopState(cwd, {
					loopName: "pausable-loop",
					maxIterations: Option.none(),
				});
			})
		);
		await command?.handler("stop", context);

		const stoppedState = readState(cwd, "pausable-loop");
		expect(stoppedState.status).toBe("completed");
		expect(notifications.some((entry) => entry.message.includes("Stopped Ralph loop: pausable-loop"))).toBe(true);
	});

	it("/ralph stop ends a paused loop after the documented ESC-style flow", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);
		const iterationSessionFile = path.join(cwd, ".pi", "sessions", "child-1.session.json");

		const notifications: Notifications = [];
		const { pi, commands } = makePiStub();
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);
		initRalph(pi, ralphRuntime.run);

		const command = commands.get("ralph");
		expect(command).toBeDefined();

		await ralphRuntime.run(
			Effect.gen(function* () {
				const ralph = yield* Ralph;
					yield* ralph.startLoopState(cwd, {
						loopName: "esc-stop-loop",
						taskFile: path.join(".pi", "loops", "tasks", "esc-stop-loop.md"),
						executionProfile: makeExecutionProfile(),
						maxIterations: 50,
					itemsPerIteration: 0,
					reflectEvery: 0,
					reflectInstructions: "reflect",
					controllerSessionFile: Option.some(path.join(cwd, ".pi", "sessions", "controller.session.json")),
					defaultTaskTemplate: "# Task\n",
				});
				const paused = yield* ralph.pauseCurrentLoop(cwd);
				expect(paused.status).toBe("paused");
			})
		);

		const context = makeContext(cwd, notifications, [true], { sessionFile: iterationSessionFile });
		await command?.handler("stop", context);

		const stoppedState = readState(cwd, "esc-stop-loop");
		expect(stoppedState.status).toBe("completed");
		expect(notifications.some((entry) => entry.message.includes("Stopped Ralph loop: esc-stop-loop"))).toBe(true);
	});

	it("/ralph stop prefers the paused loop owned by the current session over unrelated active loops", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);
		const pausedSessionFile = path.join(cwd, ".pi", "sessions", "paused-child.session.json");
		const otherSessionFile = path.join(cwd, ".pi", "sessions", "other-controller.session.json");

		const notifications: Notifications = [];
		const { pi, commands } = makePiStub();
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);
		initRalph(pi, ralphRuntime.run);

		const command = commands.get("ralph");
		expect(command).toBeDefined();

		fs.mkdirSync(path.join(cwd, ".pi", "loops", "state"), { recursive: true });
		fs.writeFileSync(
			statePath(cwd, "owned-paused"),
			encodeStateForStorage(
				decodeLoopStateSync({
					name: "owned-paused",
					taskFile: path.join(".pi", "loops", "tasks", "owned-paused.md"),
					iteration: 2,
					maxIterations: 50,
					itemsPerIteration: 0,
					reflectEvery: 0,
					reflectInstructions: "reflect",
					status: "paused",
					startedAt: "2026-01-01T00:00:00.000Z",
					completedAt: null,
					lastReflectionAt: 0,
					controllerSessionFile: path.join(cwd, ".pi", "sessions", "controller.session.json"),
					activeIterationSessionFile: pausedSessionFile,
					pendingDecision: null,
					executionProfile: makeExecutionProfile(),
				}),
			),
			"utf-8",
		);
		fs.writeFileSync(
			statePath(cwd, "other-active"),
			encodeStateForStorage(
				decodeLoopStateSync({
					name: "other-active",
					taskFile: path.join(".pi", "loops", "tasks", "other-active.md"),
					iteration: 1,
					maxIterations: 50,
					itemsPerIteration: 0,
					reflectEvery: 0,
					reflectInstructions: "reflect",
					status: "active",
					startedAt: "2026-01-01T00:00:00.000Z",
					completedAt: null,
					lastReflectionAt: 0,
					controllerSessionFile: otherSessionFile,
					activeIterationSessionFile: null,
					pendingDecision: null,
					executionProfile: makeExecutionProfile(),
				}),
			),
			"utf-8",
		);

		const context = makeContext(cwd, notifications, [true], { sessionFile: pausedSessionFile });
		await command?.handler("stop", context);

		expect(readState(cwd, "owned-paused").status).toBe("completed");
		expect(readState(cwd, "other-active").status).toBe("active");
		expect(notifications.some((entry) => entry.message.includes("Stopped Ralph loop: owned-paused"))).toBe(true);
	});

	it("does not register the legacy ralph-stop command", async () => {
		const { pi, commands } = makePiStub();
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);
		initRalph(pi, ralphRuntime.run);

		expect(commands.has("ralph-stop")).toBe(false);
		expect(commands.has("ralph")).toBe(true);
	});

	it("reports persisted-state decode failures at command boundary", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const notifications: Notifications = [];
		const { pi, commands } = makePiStub();
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);
		initRalph(pi, ralphRuntime.run);

		const command = commands.get("ralph");
		expect(command).toBeDefined();

		const invalidStatePath = statePath(cwd, "broken-loop");
		fs.mkdirSync(path.dirname(invalidStatePath), { recursive: true });
		fs.writeFileSync(
			invalidStatePath,
			JSON.stringify(
				{
					name: "broken-loop",
					taskFile: ".pi/loops/tasks/broken-loop.md",
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
					pendingDecision: null,
					executionProfile: makeExecutionProfile(),
				},
				null,
				2,
			),
			"utf-8",
		);

		const context = makeContext(cwd, notifications);
		await expect(command?.handler("status", context)).resolves.toBeUndefined();
		const message =
			notifications.find((entry) => entry.message.includes("Ralph state is invalid"))
				?.message ?? "";
		expect(message).toContain("Ralph state is invalid");
		expect(message).toContain(".pi/loops/state/broken-loop.json");
		expect(message).toContain("invalid-status");
	});

	it("archives paused loops, cleans completed loops, and nukes Ralph loop data", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const notifications: Notifications = [];
		const { pi, commands } = makePiStub();
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);
		initRalph(pi, ralphRuntime.run);
		const command = commands.get("ralph");
		expect(command).toBeDefined();

		const sleepyContext = makeContext(cwd, notifications, [true], {
			sessionFile: path.join(cwd, ".pi", "sessions", "sleepy-controller.session.json"),
		});
		const doneAContext = makeContext(cwd, notifications, [true], {
			sessionFile: path.join(cwd, ".pi", "sessions", "done-a-controller.session.json"),
		});
		const doneBContext = makeContext(cwd, notifications, [true], {
			sessionFile: path.join(cwd, ".pi", "sessions", "done-b-controller.session.json"),
		});
		await command?.handler("start sleepy-loop", sleepyContext);
		await command?.handler("start done-a", doneAContext);
		await command?.handler("start done-b", doneBContext);
		await waitFor(() => readState(cwd, "sleepy-loop").status === "paused");
		await waitFor(() => readState(cwd, "done-a").status === "paused");
		await waitFor(() => readState(cwd, "done-b").status === "paused");

		for (const loopName of ["done-a", "done-b"] as const) {
			const state = readState(cwd, loopName);
			const completedState = {
				...state,
				status: "completed" as const,
				completedAt: Option.some("2026-01-01T00:00:00.000Z"),
			};
			fs.writeFileSync(
				statePath(cwd, loopName),
				encodeStateForStorage(completedState),
				"utf-8",
			);
		}

		await command?.handler("archive sleepy-loop", sleepyContext);
		expect(fs.existsSync(statePath(cwd, "sleepy-loop"))).toBe(false);
		expect(fs.existsSync(taskPath(cwd, "sleepy-loop"))).toBe(false);
		expect(fs.existsSync(statePath(cwd, "sleepy-loop", true))).toBe(true);
		expect(fs.existsSync(taskPath(cwd, "sleepy-loop", true))).toBe(true);

		await command?.handler("clean --all", sleepyContext);
		expect(fs.existsSync(statePath(cwd, "done-a"))).toBe(false);
		expect(fs.existsSync(taskPath(cwd, "done-a"))).toBe(false);
		expect(fs.existsSync(statePath(cwd, "done-b"))).toBe(false);
		expect(fs.existsSync(taskPath(cwd, "done-b"))).toBe(false);
		expect(fs.existsSync(statePath(cwd, "sleepy-loop", true))).toBe(true);

		await command?.handler("nuke --yes", sleepyContext);
		expect(fs.existsSync(path.join(cwd, ".pi", "ralph"))).toBe(false);
		expect(
			notifications.some((entry) =>
				entry.message.includes("Removed Ralph loop data under .pi/loops."),
			),
		).toBe(true);
	});
});
