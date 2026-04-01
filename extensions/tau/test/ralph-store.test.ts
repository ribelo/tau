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

type RalphRuntimeHarness = {
	readonly run: <A, E>(effect: Effect.Effect<A, E, Ralph>) => Promise<A>;
	readonly dispose: () => Promise<void>;
};

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

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tau-ralph-store-"));
}

function statePath(cwd: string, name: string, archived = false): string {
	return path.join(cwd, ".pi", "ralph", archived ? "archive" : "", `${name}.state.json`);
}

function taskPath(cwd: string, name: string, archived = false): string {
	return path.join(cwd, ".pi", "ralph", archived ? "archive" : "", `${name}.md`);
}

function readState(cwd: string, name: string, archived = false) {
	const raw = JSON.parse(fs.readFileSync(statePath(cwd, name, archived), "utf-8"));
	return decodeLoopStateSync(raw);
}

function makeContext(
	cwd: string,
	notifications: Notifications,
	newSessionCancelled: readonly boolean[] = [true],
): ExtensionCommandContext {
	let sessionFile = path.join(cwd, ".pi", "sessions", "controller.session.json");
	let newSessionCount = 0;

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
		isIdle: () => true,
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
} {
	const eventHandlers = new Map<string, EventHandler[]>();
	const commands = new Map<string, RegisteredCommand>();
	const tools: ToolDefinition[] = [];

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
	};
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

		expect(fs.existsSync(taskPath(cwd, "alpha-loop"))).toBe(true);
		expect(fs.existsSync(statePath(cwd, "alpha-loop"))).toBe(true);

		const state = readState(cwd, "alpha-loop");
		expect(state.taskFile).toBe(path.join(".pi", "ralph", "alpha-loop.md"));
		expect(state.iteration).toBe(0);
		expect(state.status).toBe("paused");
		expect(Option.getOrUndefined(state.controllerSessionFile)).toContain("controller.session.json");
		expect(fs.readFileSync(taskPath(cwd, "alpha-loop"), "utf-8")).toContain("# Task");
		expect(notifications.some((entry) => entry.message.includes("Started loop \"alpha-loop\""))).toBe(true);
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
					taskFile: ".pi/ralph/broken-loop.md",
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

		const context = makeContext(cwd, notifications);
		await expect(command?.handler("status", context)).resolves.toBeUndefined();
		expect(
			notifications.some((entry) => entry.message.includes("Ralph state is invalid")),
		).toBe(true);
	});

	it("archives paused loops, cleans completed loops, and nukes .pi/ralph", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const notifications: Notifications = [];
		const { pi, commands } = makePiStub();
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);
		initRalph(pi, ralphRuntime.run);
		const command = commands.get("ralph");
		expect(command).toBeDefined();

		const context = makeContext(cwd, notifications, [true, true, true]);
		await command?.handler("start sleepy-loop", context);
		await command?.handler("start done-a", context);
		await command?.handler("start done-b", context);

		for (const loopName of ["done-a", "done-b"] as const) {
			const state = readState(cwd, loopName);
			const completedState = {
				...state,
				status: "completed" as const,
				completedAt: Option.some("2026-01-01T00:00:00.000Z"),
			};
			fs.writeFileSync(
				statePath(cwd, loopName),
				encodeLoopStateJsonSync(completedState),
				"utf-8",
			);
		}

		await command?.handler("archive sleepy-loop", context);
		expect(fs.existsSync(statePath(cwd, "sleepy-loop"))).toBe(false);
		expect(fs.existsSync(taskPath(cwd, "sleepy-loop"))).toBe(false);
		expect(fs.existsSync(statePath(cwd, "sleepy-loop", true))).toBe(true);
		expect(fs.existsSync(taskPath(cwd, "sleepy-loop", true))).toBe(true);

		await command?.handler("clean --all", context);
		expect(fs.existsSync(statePath(cwd, "done-a"))).toBe(false);
		expect(fs.existsSync(taskPath(cwd, "done-a"))).toBe(false);
		expect(fs.existsSync(statePath(cwd, "done-b"))).toBe(false);
		expect(fs.existsSync(taskPath(cwd, "done-b"))).toBe(false);
		expect(fs.existsSync(statePath(cwd, "sleepy-loop", true))).toBe(true);

		await command?.handler("nuke --yes", context);
		expect(fs.existsSync(path.join(cwd, ".pi", "ralph"))).toBe(false);
		expect(notifications.some((entry) => entry.message.includes("Removed .pi/ralph directory."))).toBe(true);
	});
});
