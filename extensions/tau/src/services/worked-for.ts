import { Context, Effect, Layer } from "effect";

import { PiAPI } from "../effect/pi.js";
import { Persistence } from "./persistence.js";
import type { TauState } from "../shared/state.js";

// We'll import everything from the old worked-for/index.js for now,
// but we'll wrap the initialization.
import initWorkedForLegacy from "../worked-for/index.js";

export interface WorkedFor {
	readonly setup: Effect.Effect<void>;
}

export const WorkedFor = Context.GenericTag<WorkedFor>("WorkedFor");

export const WorkedForLive = Layer.effect(
	WorkedFor,
	Effect.gen(function* () {
		const pi = yield* PiAPI;
		const persistence = yield* Persistence;

		return WorkedFor.of({
			setup: Effect.gen(function* () {
				yield* Effect.sync(() => {
					// Bridge persistence state to legacy state
					const legacyState = {
						get persisted() {
							return Effect.runSync(persistence.state.get);
						},
					};
					initWorkedForLegacy(pi, legacyState as unknown as TauState);
				});
			}),
		});
	}),
);
