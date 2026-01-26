import { Context, Effect, Layer } from "effect";

import { PiAPI } from "../effect/pi.js";
import type { TauState } from "../shared/state.js";

// We'll import everything from the old beads/index.js for now,
// but we'll wrap the initialization.
import initBeadsLegacy from "../beads/index.js";

export interface Beads {
	readonly setup: Effect.Effect<void>;
}

export const Beads = Context.GenericTag<Beads>("Beads");

export const BeadsLive = Layer.effect(
	Beads,
	Effect.gen(function* () {
		const pi = yield* PiAPI;

		return Beads.of({
			setup: Effect.gen(function* () {
				// No logs here to avoid TUI pollution
				yield* Effect.sync(() => {
					// We use a mock state for now as Beads doesn't really use it
					initBeadsLegacy(pi, {} as unknown as TauState);
				});
			}),
		});
	}),
);
