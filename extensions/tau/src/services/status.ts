import type { TauState } from "../shared/state.js";
import { Context, Effect, Layer } from "effect";

import { PiAPI } from "../effect/pi.js";
import { Persistence } from "./persistence.js";
import { makeLegacyStateBridge } from "./legacy-bridge.js";

// We'll import everything from the old status/index.js for now,
// but we'll wrap the initialization.
import initStatusLegacy from "../status/index.js";

export interface Status {
	readonly setup: Effect.Effect<void>;
}

export const Status = Context.GenericTag<Status>("Status");

export const StatusLive = Layer.effect(
	Status,
	Effect.gen(function* () {
		const pi = yield* PiAPI;
		const persistence = yield* Persistence;

		return Status.of({
			setup: Effect.gen(function* () {
				yield* Effect.sync(() => {
					initStatusLegacy(pi, makeLegacyStateBridge(persistence.state) as unknown as TauState);
				});
			}),
		});
	}),
);
