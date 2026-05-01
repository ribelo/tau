import { afterEach, describe, expect, it } from "vitest";
import { Deferred, Effect, Fiber, ManagedRuntime, Ref } from "effect";

import {
	AutoresearchLoopRunner,
	AutoresearchLoopRunnerLive,
} from "../src/services/autoresearch-loop-runner.js";

type RuntimeHarness = {
	readonly run: <A, E>(effect: Effect.Effect<A, E, AutoresearchLoopRunner>) => Promise<A>;
	readonly dispose: () => Promise<void>;
};

function makeRuntime(): RuntimeHarness {
	const runtime = ManagedRuntime.make(AutoresearchLoopRunnerLive);
	return {
		run: (effect) => runtime.runPromise(effect),
		dispose: () => runtime.dispose(),
	};
}

describe("AutoresearchLoopRunner", () => {
	const runtimes: RuntimeHarness[] = [];

	afterEach(async () => {
		for (const runtime of runtimes.splice(0)) {
			await runtime.dispose();
		}
	});

	it("starts at most one active loop per loop key", async () => {
		const runtime = makeRuntime();
		runtimes.push(runtime);

		await runtime.run(
			Effect.gen(function* () {
				const runner = yield* AutoresearchLoopRunner;
				const starts = yield* Ref.make(0);
				const gate = yield* Deferred.make<void>();

				yield* runner.ensureLoopRunning(
					"workspace:task-1",
					Effect.gen(function* () {
						yield* Ref.update(starts, (count) => count + 1);
						yield* Deferred.await(gate);
					}),
				);

				yield* runner.ensureLoopRunning(
					"workspace:task-1",
					Ref.update(starts, (count) => count + 100),
				);

				expect(yield* Ref.get(starts)).toBe(1);

				yield* Deferred.succeed(gate, undefined);
				yield* Effect.sleep("10 millis");

				yield* runner.ensureLoopRunning(
					"workspace:task-1",
					Ref.update(starts, (count) => count + 1),
				);
				yield* Effect.sleep("10 millis");

				expect(yield* Ref.get(starts)).toBe(2);
			}),
		);
	});

	it("interrupts active loops when cancelled", async () => {
		const runtime = makeRuntime();
		runtimes.push(runtime);

		await runtime.run(
			Effect.gen(function* () {
				const runner = yield* AutoresearchLoopRunner;
				const interrupted = yield* Ref.make(false);
				const gate = yield* Deferred.make<void>();

				yield* runner.ensureLoopRunning(
					"workspace:task-2",
					Deferred.await(gate).pipe(
						Effect.onInterrupt(() => Ref.set(interrupted, true)),
					),
				);

				yield* runner.cancelLoop("workspace:task-2");
				yield* Effect.sleep("10 millis");

				expect(yield* Ref.get(interrupted)).toBe(true);
			}),
		);
	});

	it("resolves waiters from agent end events", async () => {
		const runtime = makeRuntime();
		runtimes.push(runtime);

		await runtime.run(
			Effect.gen(function* () {
				const runner = yield* AutoresearchLoopRunner;

				const waited = yield* runner.waitForAgentEnd("session-a").pipe(Effect.forkDetach);
				yield* Effect.yieldNow;
				yield* runner.resolveAgentEnd("session-a", { status: "done" });
				const resolved = yield* Fiber.join(waited);
				expect(resolved).toEqual({ _tag: "completed", event: { status: "done" } });
			}),
		);
	});

	it("queues agent end events that arrive before waiters", async () => {
		const runtime = makeRuntime();
		runtimes.push(runtime);

		await runtime.run(
			Effect.gen(function* () {
				const runner = yield* AutoresearchLoopRunner;

				yield* runner.resolveAgentEnd("session-before-wait", { status: "done" });
				const resolved = yield* runner.waitForAgentEnd("session-before-wait");
				expect(resolved).toEqual({ _tag: "completed", event: { status: "done" } });
			}),
		);
	});
});
