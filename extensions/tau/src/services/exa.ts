import { Context, Effect, Layer } from "effect";

import { PiAPI } from "../effect/pi.js";

// We'll import everything from the old exa/index.js for now,
// but we'll wrap the initialization.
import initExaLegacy from "../exa/index.js";

export interface Exa {
	readonly setup: Effect.Effect<void>;
}

export const Exa = Context.GenericTag<Exa>("Exa");

export const ExaLive = Layer.effect(
	Exa,
	Effect.gen(function* () {
		const pi = yield* PiAPI;

		return Exa.of({
			setup: Effect.gen(function* () {
				yield* Effect.sync(() => {
					initExaLegacy(pi, {} as any);
				});
			}),
		});
	}),
);
