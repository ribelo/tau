import { Cause, Effect, Fiber, Layer, ManagedRuntime } from "effect";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";

import { PiAPILive } from "./effect/pi.js";
import { PiLoggerLive } from "./effect/logger.js";
import { Sandbox, SandboxLive } from "./services/sandbox.js";
import { SandboxStateLive } from "./services/state.js";
import { Footer, FooterLive } from "./services/footer.js";
import { PromptModes, PromptModesLive } from "./services/prompt-modes.js";
import { Persistence, PersistenceLive } from "./services/persistence.js";
import { CuratedMemory, CuratedMemoryLive } from "./services/curated-memory.js";
import { SkillManager, SkillManagerLive } from "./services/skill-manager.js";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import initBacklog from "./backlog/tool.js";
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
import initAgentsMenu from "./agents-menu/index.js";
import { isAgentDisabled } from "./agents-menu/index.js";
import { AgentConfig, AgentControl } from "./agent/services.js";
import { AgentControlLive } from "./agent/control.js";
import { AgentManagerLive } from "./agent/manager.js";
import {
	AgentRuntimeBridgeLive,
	type AgentRuntimeBridgeService,
} from "./agent/runtime.js";
import { AgentRegistry } from "./agent/agent-registry.js";
import { buildToolDescription } from "./agent/tool.js";
import { createSkillMarkerRuntime } from "./skill-marker/index.js";

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
const PromptModesLayer = PromptModesLive.pipe(Layer.provide(PersistenceLayer));
const CuratedMemoryLayer = CuratedMemoryLive;
const skillMutationCallback: { current: () => void } = { current: () => {} };
const SkillManagerLayer = SkillManagerLive({
	onSkillMutated: () => skillMutationCallback.current(),
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

	return Layer.mergeAll(
		PersistenceLayer,
		SandboxLayer,
		FooterLayer,
		PromptModesLayer,
		CuratedMemoryLayer,
		SkillManagerLayer,
		AgentLayer,
	).pipe(Layer.provide(PiLoggerLive));
};

type TauRuntime = ManagedRuntime.ManagedRuntime<
	Persistence | Sandbox | Footer | PromptModes | CuratedMemory | AgentControl | SkillManager,
	never
>;

export const runTau = (pi: ExtensionAPI) => {
	return startTau(pi).fiber;
};

export const startTau = (pi: ExtensionAPI) => {
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
			agentRuntimeBridge.runPromise(
				Effect.gen(function* () {
					const control = yield* AgentControl;
					yield* control.closeAll;
				}),
			).then(() => undefined),
	};

	const layer = createMainLayer(agentRuntimeBridge).pipe(Layer.provide(PiAPILive(pi)));
	const currentRuntime = ManagedRuntime.make(layer);
	runtime = currentRuntime;
	const runCuratedMemory = <A, E>(effect: Effect.Effect<A, E, CuratedMemory>) =>
		currentRuntime.runPromise(effect);
	const runSkillManager = <A, E>(effect: Effect.Effect<A, E, SkillManager>) =>
		currentRuntime.runPromise(effect);

	const startup = Effect.gen(function* () {
			const persistence = yield* Persistence;
			const sandbox = yield* Sandbox;
			const footer = yield* Footer;
			const promptModes = yield* PromptModes;
			const curatedMemory = yield* CuratedMemory;
			const skillMarker = createSkillMarkerRuntime();
			skillMutationCallback.current = () => {
				void reloadSkills(skillMarker, process.cwd());
			};
			const persistedAccess = {
				getSnapshot: persistence.getSnapshot,
				update: persistence.update,
			};

			yield* persistence.setup;
			yield* sandbox.setup;
			yield* footer.setup;
			yield* promptModes.setup;
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
				initSkillManage(pi, runSkillManager);
				initNudge(pi);
				initRequestUserInput(pi);
				initRalph(pi);
			});

			const agentRegistry = yield* AgentRegistry.load(process.cwd());
			const agentToolDescription = buildToolDescription(agentRegistry, undefined, isAgentDisabled);
			yield* Effect.sync(() => {
				const agentToolHandle = initAgent(pi, agentRuntimeBridge, agentToolDescription);
				initAgentsMenu(pi, agentToolHandle);
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

	pi.on("session_shutdown", async () => {
		if (disposed) return;
		disposed = true;
		await Effect.runPromise(Fiber.interrupt(rootFiber));
		await currentRuntime.dispose();
		runtime = undefined;
	});

	return { fiber: rootFiber, ready };
};
