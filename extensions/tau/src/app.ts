import { Cause, Effect, Fiber, Layer, ManagedRuntime } from "effect";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";

import { PiAPILive } from "./effect/pi.js";
import { PiLoggerLive } from "./effect/logger.js";
import { Sandbox, SandboxLive } from "./services/sandbox.js";
import { SandboxStateLive } from "./services/state.js";
import { Footer, FooterLive } from "./services/footer.js";
import { PromptModes, PromptModesLive } from "./services/prompt-modes.js";
import { Persistence, PersistenceLive } from "./services/persistence.js";
import { ExecutionState, ExecutionStateLive } from "./services/execution-state.js";
import { ExecutionRuntime, ExecutionRuntimeLive } from "./services/execution-runtime.js";
import { CuratedMemory, CuratedMemoryLive } from "./services/curated-memory.js";
import { Ralph, RalphLive } from "./services/ralph.js";
import { SkillManager, SkillManagerLive } from "./services/skill-manager.js";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import initExa from "./exa/index.js";
import initMemory from "./memory/index.js";
import initSkillManage from "./skill-manage/index.js";
import initNudge from "./nudge/index.js";
import initTerminalPrompt from "./terminal-prompt/index.js";
import initWorkedFor from "./worked-for/index.js";
import { initStatus } from "./status/index.js";
import initCommit from "./commit/index.js";
import initEditor from "./editor/index.js";
import initSkillMarker from "./skill-marker/index.js";
import { reloadSkills } from "./skill-marker/index.js";
import initAgent from "./agent/index.js";
import initRequestUserInput from "./request-user-input/index.js";
import initRalph from "./ralph/index.js";
import initAutoresearch from "./autoresearch/index.js";
import initAgentsMenu from "./agents-menu/index.js";
import initThreadTools from "./thread/index.js";
import { AgentConfig, AgentControl } from "./agent/services.js";
import { AgentControlLive } from "./agent/control.js";
import { AgentManagerLive } from "./agent/manager.js";
import { AgentRuntimeBridgeLive, type AgentRuntimeBridgeService } from "./agent/runtime.js";
import { buildToolDescription } from "./agent/tool.js";
import { createSkillMarkerRuntime } from "./skill-marker/index.js";
import { installSqliteExperimentalWarningFilter } from "./shared/sqlite-warning.js";
import { RalphRepoLive } from "./ralph/repo.js";
import { LoopRepoLive } from "./loops/repo.js";
import { LoopEngine, LoopEngineLive } from "./services/loop-engine.js";
import initDream from "./dream/init.js";
import { DreamLockLive } from "./dream/lock.js";
import { DreamSchedulerLive } from "./dream/scheduler.js";
import { DreamSubagentLive } from "./dream/subagent.js";
import { DreamTaskRegistryLive } from "./dream/task-registry.js";
import { loadDreamConfig } from "./dream/config-loader.js";
import type { DreamLock } from "./dream/lock.js";
import type { DreamScheduler } from "./dream/scheduler.js";
import type { DreamTaskRegistry } from "./dream/task-registry.js";
import type { DreamSubagent } from "./dream/subagent.js";

const PersistenceLayer = PersistenceLive;
const SandboxLayer = SandboxLive.pipe(
	Layer.provide(SandboxStateLive),
	Layer.provide(PersistenceLayer),
);
const FooterLayer = FooterLive.pipe(
	Layer.provide(NodeFileSystem.layer),
	Layer.provide(PersistenceLayer),
	Layer.provide(SandboxLayer),
);
const ExecutionStateLayer = ExecutionStateLive.pipe(Layer.provide(PersistenceLayer));
const ExecutionRuntimeLayer = ExecutionRuntimeLive.pipe(Layer.provide(ExecutionStateLayer));
const PromptModesLayer = PromptModesLive.pipe(Layer.provide(ExecutionRuntimeLayer));
const CuratedMemoryLayer = CuratedMemoryLive;
const DreamSchedulerLayer = DreamSchedulerLive({ loadConfig: loadDreamConfig }).pipe(
	Layer.provide(DreamLockLive),
);
const skillMutationCallback: { current: (cwd: string) => void } = { current: () => {} };
const SkillManagerLayer = SkillManagerLive({
	onSkillMutated: (cwd) => skillMutationCallback.current(cwd),
});
const AgentConfigLive = Layer.succeed(
	AgentConfig,
	AgentConfig.of({
		maxThreads: 12,
		maxDepth: 3,
	}),
);

const createMainLayer = (agentRuntimeBridge: AgentRuntimeBridgeService) => {
	const AgentLayer = AgentControlLive.pipe(
		Layer.provide(AgentManagerLive),
		Layer.provide(AgentConfigLive),
		Layer.provide(AgentRuntimeBridgeLive(agentRuntimeBridge.runPromise)),
		Layer.provide(SandboxLayer),
	);

	const hasActiveSubagents = (): Effect.Effect<boolean, never, never> =>
		Effect.promise(() =>
			agentRuntimeBridge.runPromise(
				Effect.gen(function* () {
					const control = yield* AgentControl;
					return yield* control.list;
				}),
			),
		).pipe(
			Effect.map((agents) =>
				agents.some(
					(agent) => agent.status.state === "pending" || agent.status.state === "running",
				),
			),
			Effect.catch(() => Effect.succeed(false)),
		);

	const RalphLayer = RalphLive({
		hasActiveSubagents,
	}).pipe(
		Layer.provideMerge(RalphRepoLive),
		Layer.provideMerge(LoopEngineLive.pipe(Layer.provideMerge(LoopRepoLive))),
		Layer.provide(NodeFileSystem.layer),
	);

	return Layer.mergeAll(
		PersistenceLayer,
		ExecutionStateLayer,
		ExecutionRuntimeLayer,
		SandboxLayer,
		FooterLayer,
		PromptModesLayer,
		CuratedMemoryLayer,
		DreamLockLive,
		DreamSchedulerLayer,
		DreamTaskRegistryLive,
		DreamSubagentLive,
		SkillManagerLayer,
		AgentLayer,
		RalphLayer,
	).pipe(Layer.provide(PiLoggerLive));
};

type TauRuntime = ManagedRuntime.ManagedRuntime<
	| Persistence
	| ExecutionState
	| ExecutionRuntime
	| Sandbox
	| Footer
	| PromptModes
	| CuratedMemory
	| AgentControl
	| SkillManager
	| Ralph
	| LoopEngine
	| DreamLock
	| DreamScheduler
	| DreamTaskRegistry
	| DreamSubagent,
	never
>;

export const runTau = (pi: ExtensionAPI) => {
	return startTau(pi).fiber;
};

export const startTau = (pi: ExtensionAPI) => {
	installSqliteExperimentalWarningFilter();
	let runtime: TauRuntime | undefined;
	let readySettled = false;
	let resolveReady!: () => void;
	let rejectReady!: (error: unknown) => void;
	const ready = new Promise<void>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});

	const agentRuntimeBridge: AgentRuntimeBridgeService = {
		runPromise: (effect) => {
			if (!runtime) {
				return Promise.reject(new Error("tau runtime not initialized"));
			}
			return runtime.runPromise(effect);
		},
		closeAll: () =>
			agentRuntimeBridge
				.runPromise(
					Effect.gen(function* () {
						const control = yield* AgentControl;
						yield* control.closeAll;
					}),
				)
				.then(() => undefined),
	};

	const layer = createMainLayer(agentRuntimeBridge).pipe(Layer.provide(PiAPILive(pi)));
	const currentRuntime = ManagedRuntime.make(layer);
	runtime = currentRuntime;
	const runCuratedMemory = <A, E>(effect: Effect.Effect<A, E, CuratedMemory>) =>
		currentRuntime.runPromise(effect);
	const runDream = <A, E>(
		effect: Effect.Effect<
			A,
			E,
			CuratedMemory | DreamLock | DreamScheduler | DreamTaskRegistry | DreamSubagent
		>,
	) => currentRuntime.runPromise(effect);
	const runSkillManager = <A, E>(effect: Effect.Effect<A, E, SkillManager>) =>
		currentRuntime.runPromise(effect);
	const runRalph = <A, E>(effect: Effect.Effect<A, E, Ralph | PromptModes>) =>
		currentRuntime.runPromise(effect);
	const runAutoresearch = <A, E>(
		effect: Effect.Effect<A, E, LoopEngine | Sandbox | PromptModes>,
	) => currentRuntime.runPromise(effect);

	const startup = Effect.gen(function* () {
		const { default: initBacklog } = yield* Effect.promise(() => import("./backlog/tool.js"));
		const persistence = yield* Persistence;
		const executionState = yield* ExecutionState;
		const executionRuntime = yield* ExecutionRuntime;
		const sandbox = yield* Sandbox;
		const footer = yield* Footer;
		const curatedMemory = yield* CuratedMemory;
		const skillMarker = createSkillMarkerRuntime();
		skillMutationCallback.current = (cwd) => {
			void reloadSkills(skillMarker, cwd);
		};
		const persistedAccess = {
			getSnapshot: persistence.getSnapshot,
			update: persistence.update,
		};

		yield* persistence.setup;
		yield* executionState.setup;
		yield* executionRuntime.setup;
		yield* sandbox.setup;
		yield* footer.setup;
		yield* curatedMemory.setup;
		yield* Effect.sync(() => {
			initBacklog(pi);
			initExa(pi);
			initTerminalPrompt(pi, persistedAccess);
			initWorkedFor(pi, persistedAccess);
			initStatus(pi, persistedAccess);
			initCommit(pi);
			initEditor(pi, {
				getSnapshot: persistence.getSnapshot,
				skillMarker,
			});
			initSkillMarker(pi, skillMarker);
			initMemory(pi, runCuratedMemory);
			initDream(pi, runDream);
			initSkillManage(pi, runSkillManager);
			initNudge(pi);
			initRequestUserInput(pi);
			initRalph(pi, runRalph);
			initAutoresearch(pi, runAutoresearch);
			initThreadTools(pi);
		});

		const agentToolDescription = buildToolDescription({
			list: () => [],
		});
		yield* Effect.sync(() => {
			const agentToolHandle = initAgent(pi, agentRuntimeBridge, agentToolDescription);
			initAgentsMenu(pi, agentToolHandle);
			pi.on("session_shutdown", async () => {
				if (disposed) return;
				disposed = true;
				await Effect.runPromise(Fiber.interrupt(rootFiber));
				await currentRuntime.dispose();
				runtime = undefined;
			});
		});
	});

	const program = Effect.scoped(
		Effect.matchCauseEffect(startup, {
			onSuccess: () =>
				Effect.sync(() => {
					if (readySettled) return;
					readySettled = true;
					resolveReady();
				}),
			onFailure: (cause) =>
				Effect.sync(() => {
					if (readySettled) return;
					readySettled = true;
					rejectReady(Cause.squash(cause));
				}).pipe(Effect.andThen(Effect.failCause(cause))),
		}).pipe(Effect.andThen(Effect.never)),
	);

	const rootFiber = currentRuntime.runFork(program);
	let disposed = false;

	return { fiber: rootFiber, ready };
};
