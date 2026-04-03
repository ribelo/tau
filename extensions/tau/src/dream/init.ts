import { Effect, Option } from "effect";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";

import { loadDreamConfig } from "./config-loader.js";
import type { DreamRunRequest, DreamTaskState } from "./domain.js";
import type { DreamLock } from "./lock.js";
import { DreamRunner, DreamRunnerLive, type DreamRunnerApi } from "./runner.js";
import type { DreamScheduler } from "./scheduler.js";
import type { CuratedMemory } from "../services/curated-memory.js";
import { DreamTaskRegistry, type DreamTaskRegistryApi } from "./task-registry.js";
import type { DreamSubagent } from "./subagent.js";

type DreamRuntimeServices =
	| CuratedMemory
	| DreamLock
	| DreamScheduler
	| DreamSubagent
	| DreamTaskRegistry;

type RunDream = <A, E>(effect: Effect.Effect<A, E, DreamRuntimeServices>) => Promise<A>;

type DreamInitOptions = {
	readonly pollMs?: number;
	readonly maxPolls?: number;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly runner?: DreamRunnerApi;
	readonly registry?: DreamTaskRegistryApi;
};

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_MAX_POLLS = 300;

export default function initDream(
	pi: ExtensionAPI,
	runEffect: RunDream,
	options?: DreamInitOptions,
): void {
	const pollMs = options?.pollMs ?? DEFAULT_POLL_MS;
	const maxPolls = options?.maxPolls ?? DEFAULT_MAX_POLLS;
	const sleep = options?.sleep ?? defaultSleep;

	const withRunner = <A, E>(
		ctx: ExtensionContext | ExtensionCommandContext,
		f: (runner: DreamRunnerApi) => Effect.Effect<A, E, never>,
	): Promise<A> => {
		const effect = Effect.gen(function* () {
			const runner = yield* DreamRunner;
			return yield* f(runner);
		});

		if (options?.runner !== undefined) {
			return runEffect(effect.pipe(Effect.provideService(DreamRunner, DreamRunner.of(options.runner))));
		}

		return runEffect(
			effect.pipe(
				Effect.provide(
					DreamRunnerLive({
						loadConfig: loadDreamConfig,
						modelRegistry: ctx.modelRegistry,
					}),
				),
			),
		);
	};

	const withRegistry = <A, E>(
		f: (registry: DreamTaskRegistryApi) => Effect.Effect<A, E, never>,
	): Promise<A> => {
		const effect = Effect.gen(function* () {
			const registry = yield* DreamTaskRegistry;
			return yield* f(registry);
		});

		if (options?.registry !== undefined) {
			return runEffect(
				effect.pipe(
					Effect.provideService(DreamTaskRegistry, DreamTaskRegistry.of(options.registry)),
				),
			);
		}

		return runEffect(effect);
	};

	pi.registerCommand("dream", {
		description: "Run memory consolidation (dream)",
		handler: async (_args, ctx) => {
			try {
				const handle = await withRunner(ctx, (runner) => runner.spawnManual(makeRunRequest(ctx, "manual", "user")));

				if (ctx.hasUI) {
					ctx.ui.notify(
						`Dream started (task ${handle.taskId}). Memory consolidation running in background.`,
						"info",
					);
				}

				void pollTaskCompletion(ctx, handle.taskId);
			} catch (error) {
				if (ctx.hasUI) {
					ctx.ui.notify(describeError(error), "warning");
				}
			}
		},
	});

	const autoSpawnHandler = async (_event: unknown, ctx: ExtensionContext): Promise<void> => {
		await tryAutoSpawn(ctx, { awaitCompletion: false });
	};

	const shutdownAutoSpawnHandler = async (
		_event: unknown,
		ctx: ExtensionContext,
	): Promise<void> => {
		await tryAutoSpawn(ctx, { awaitCompletion: true });
	};

	pi.on("session_start", autoSpawnHandler);
	pi.on("agent_end", autoSpawnHandler);
	pi.on("session_switch", autoSpawnHandler);
	pi.on("session_shutdown", shutdownAutoSpawnHandler);

	async function tryAutoSpawn(
		ctx: ExtensionContext,
		options: { readonly awaitCompletion: boolean },
	): Promise<void> {
		try {
			const result = await withRunner(ctx, (runner) => runner.maybeSpawnAuto(makeRunRequest(ctx, "auto", "scheduler")));

			if (Option.isSome(result)) {
				if (ctx.hasUI) {
					ctx.ui.notify(`Auto-dream started (task ${result.value.taskId})`, "info");
				}

				if (options.awaitCompletion) {
					await pollTaskCompletion(ctx, result.value.taskId);
				} else {
					void pollTaskCompletion(ctx, result.value.taskId);
				}
			}
		} catch (error) {
			void runEffect(Effect.logDebug(`dream auto gate closed: ${describeError(error)}`)).catch(() => undefined);
		}
	}

	async function pollTaskCompletion(ctx: ExtensionContext, taskId: string): Promise<void> {
		for (let pollIndex = 0; pollIndex < maxPolls; pollIndex += 1) {
			await sleep(pollMs);

			try {
				const state = await withRegistry((registry) => registry.get(taskId));
				updateTaskStatus(ctx, state);

				if (state.status === "completed") {
					clearTaskStatus(ctx);
					if (ctx.hasUI) {
						ctx.ui.notify(formatCompletion(state), "info");
					}
					return;
				}

				if (state.status === "failed" || state.status === "cancelled") {
					clearTaskStatus(ctx);
					if (ctx.hasUI) {
						ctx.ui.notify(
							`Dream ${state.status}: ${state.latestMessage ?? "no details"}`,
							"warning",
						);
					}
					return;
				}
			} catch {
				clearTaskStatus(ctx);
				return;
			}
		}

		clearTaskStatus(ctx);
	}
}

function makeRunRequest(
	ctx: ExtensionContext | ExtensionCommandContext,
	mode: DreamRunRequest["mode"],
	requestedBy: DreamRunRequest["requestedBy"],
): DreamRunRequest {
	const currentSessionId = currentSessionIdOf(ctx);

	return {
		cwd: ctx.cwd,
		mode,
		requestedBy,
		...(currentSessionId === undefined ? {} : { currentSessionId }),
	};
}

function currentSessionIdOf(ctx: ExtensionContext | ExtensionCommandContext): string | undefined {
	const sessionId = ctx.sessionManager?.getSessionId?.();
	return typeof sessionId === "string" ? sessionId : undefined;
}

function updateTaskStatus(ctx: ExtensionContext, state: DreamTaskState): void {
	if (!ctx.hasUI) {
		return;
	}

	const ops = state.operationsPlanned > 0
		? ` (${state.operationsApplied}/${state.operationsPlanned} ops)`
		: "";
	ctx.ui.setStatus("dream", `dream: ${state.phase}${ops}`);
	if (typeof ctx.ui.setWidget === "function") {
		ctx.ui.setWidget("dream", dreamWidgetLines(state));
	}
}

function clearTaskStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) {
		return;
	}

	ctx.ui.setStatus("dream", undefined);
	if (typeof ctx.ui.setWidget === "function") {
		ctx.ui.setWidget("dream", undefined);
	}
}

function formatCompletion(state: DreamTaskState): string {
	const base = `Dream complete: reviewed ${state.sessionsReviewed} session(s), applied ${state.operationsApplied}/${state.operationsPlanned} operation(s).`;
	if (state.latestMessage) {
		return `${base} ${state.latestMessage.slice(0, 120)}${state.latestMessage.length > 120 ? "..." : ""}`;
	}
	return base;
}

function dreamWidgetLines(state: DreamTaskState): string[] {
	return [
		"Dream",
		`Mode: ${state.mode}`,
		`Phase: ${state.phase}`,
		`Sessions: ${state.sessionsReviewed}/${state.sessionsDiscovered}`,
		`Operations: ${state.operationsApplied}/${state.operationsPlanned}`,
		`Status: ${state.status}`,
		...(state.latestMessage === undefined ? [] : [`Note: ${state.latestMessage}`]),
	];
}

function describeError(error: unknown): string {
	if (typeof error !== "object" || error === null || !("_tag" in error)) {
		return `Dream failed: ${String(error)}`;
	}

	const tagged = error as { readonly _tag: string; readonly mode?: string };
	if (tagged._tag === "DreamDisabled") {
		return `Dream is disabled${tagged.mode === undefined ? "" : ` (mode: ${tagged.mode})`}. Enable it in settings.json under tau.dream.enabled`;
	}

	if (tagged._tag === "DreamLockHeld") {
		return "Another dream run is already in progress.";
	}

	if (
		tagged._tag === "DreamConfigDecodeError" ||
		tagged._tag === "DreamConfigMissingModel" ||
		tagged._tag === "DreamConfigInvalidThreshold"
	) {
		return `Dream configuration error: define tau.dream explicitly (enabled/manual/auto/subagent.model/subagent.thinking/subagent.maxTurns). Dream has no implicit defaults. Details: ${String(error)}`;
	}

	if (tagged._tag === "DreamSubagentSpawnFailed" || tagged._tag === "DreamSubagentInvalidPlan") {
		const reason = "reason" in error ? (error as { reason: string }).reason : tagged._tag;
		return `Dream failed: ${reason}`;
	}

	return `Dream failed: ${tagged._tag}`;
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export { describeError as _describeDreamError };
