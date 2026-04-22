import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Scope, ServiceMap } from "effect";

export type WaitForAutoresearchAgentEndResult =
	| {
		readonly _tag: "completed";
		readonly event: unknown;
	}
	| {
		readonly _tag: "timed_out";
	}
	| {
		readonly _tag: "cancelled";
	};

export interface AutoresearchLoopRunnerService {
	readonly ensureLoopRunning: (
		loopKey: string,
		program: Effect.Effect<void, never, never>,
	) => Effect.Effect<void, never, never>;
	readonly cancelLoop: (loopKey: string) => Effect.Effect<void, never, never>;
	readonly waitForAgentEnd: (
		sessionFile: string,
	) => Effect.Effect<WaitForAutoresearchAgentEndResult, never, never>;
	readonly resolveAgentEnd: (
		sessionFile: string,
		event: unknown,
	) => Effect.Effect<void, never, never>;
}

export class AutoresearchLoopRunner extends ServiceMap.Service<
	AutoresearchLoopRunner,
	AutoresearchLoopRunnerService
>()("AutoresearchLoopRunner") {}

const AUTORESEARCH_AGENT_END_WAIT_TIMEOUT = "30 minutes";

export const AutoresearchLoopRunnerLive = Layer.effect(
	AutoresearchLoopRunner,
	Effect.gen(function* () {
		const serviceScope = yield* Effect.scope;
		const backgroundScope = yield* Scope.make();
		yield* Scope.addFinalizer(serviceScope, Scope.close(backgroundScope, Exit.void));

		const activeLoops = new Map<string, Fiber.Fiber<void, never>>();
		const waitingAgentEnds = new Map<string, Deferred.Deferred<unknown>>();

		const ensureLoopRunning: AutoresearchLoopRunnerService["ensureLoopRunning"] = Effect.fn(
			"AutoresearchLoopRunner.ensureLoopRunning",
		)(function* (loopKey, program) {
			if (activeLoops.has(loopKey)) {
				return;
			}

			const fiber = yield* program.pipe(
				Effect.ensuring(
					Effect.sync(() => {
						activeLoops.delete(loopKey);
					}),
				),
				Effect.forkIn(backgroundScope, { startImmediately: true }),
			);

			activeLoops.set(loopKey, fiber);
		});

		const cancelLoop: AutoresearchLoopRunnerService["cancelLoop"] = Effect.fn(
			"AutoresearchLoopRunner.cancelLoop",
		)(function* (loopKey) {
			const active = activeLoops.get(loopKey);
			if (active === undefined) {
				return;
			}

			yield* Fiber.interrupt(active).pipe(Effect.ignore);
			activeLoops.delete(loopKey);
		});

		const waitForAgentEnd: AutoresearchLoopRunnerService["waitForAgentEnd"] = Effect.fn(
			"AutoresearchLoopRunner.waitForAgentEnd",
		)(function* (sessionFile) {
			const deferred = yield* Deferred.make<unknown>();
			waitingAgentEnds.set(sessionFile, deferred);

			const waitForResult = Deferred.await(deferred).pipe(
				Effect.timeoutOption(AUTORESEARCH_AGENT_END_WAIT_TIMEOUT),
				Effect.map((eventOption): WaitForAutoresearchAgentEndResult =>
					Option.match(eventOption, {
						onNone: () => ({ _tag: "timed_out" }),
						onSome: (event) => ({ _tag: "completed", event }),
					}),
				),
				Effect.catchCause((cause) =>
					Cause.hasInterrupts(cause)
						? Effect.succeed<WaitForAutoresearchAgentEndResult>({ _tag: "cancelled" })
						: Effect.failCause(cause),
				),
				Effect.ensuring(
					Effect.sync(() => {
						const waiting = waitingAgentEnds.get(sessionFile);
						if (waiting === deferred) {
							waitingAgentEnds.delete(sessionFile);
						}
					}),
				),
			);

			return yield* waitForResult;
		});

		const resolveAgentEnd: AutoresearchLoopRunnerService["resolveAgentEnd"] = Effect.fn(
			"AutoresearchLoopRunner.resolveAgentEnd",
		)(function* (sessionFile, event) {
			const deferred = waitingAgentEnds.get(sessionFile);
			if (deferred === undefined) {
				return;
			}

			waitingAgentEnds.delete(sessionFile);
			yield* Deferred.succeed(deferred, event).pipe(Effect.ignore);
		});

		return AutoresearchLoopRunner.of({
			ensureLoopRunning,
			cancelLoop,
			waitForAgentEnd,
			resolveAgentEnd,
		});
	}),
);
