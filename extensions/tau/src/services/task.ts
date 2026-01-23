import { Context, Effect, Layer } from "effect";

import { PiAPI } from "../effect/pi.js";
import { Persistence } from "./persistence.js";
import { makeLegacyStateBridge } from "./legacy-bridge.js";

// We'll import everything from the old task/index.js for now,
// but we'll wrap the initialization.
import initTaskLegacy from "../task/index.js";

export interface Task {
	readonly setup: Effect.Effect<void>;
}

export const Task = Context.GenericTag<Task>("Task");

export const TaskLive = Layer.effect(
	Task,
	Effect.gen(function* () {
		const pi = yield* PiAPI;
		const persistence = yield* Persistence;

		return Task.of({
			setup: Effect.gen(function* () {
				yield* Effect.sync(() => {
					initTaskLegacy(pi, makeLegacyStateBridge(persistence.state) as any);
				});
			}),
		});
	}),
);
