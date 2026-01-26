import type { TauState } from "../shared/state.js";
import { Context, Effect, Layer } from "effect";

import { PiAPI } from "../effect/pi.js";
import { Persistence } from "./persistence.js";
import { makeLegacyStateBridge } from "./legacy-bridge.js";

// We'll import everything from the old skill-marker/index.js for now,
// but we'll wrap the initialization.
import initSkillMarkerLegacy from "../skill-marker/index.js";

export interface SkillMarker {
	readonly setup: Effect.Effect<void>;
}

export const SkillMarker = Context.GenericTag<SkillMarker>("SkillMarker");

export const SkillMarkerLive = Layer.effect(
	SkillMarker,
	Effect.gen(function* () {
		const pi = yield* PiAPI;
		const persistence = yield* Persistence;

		return SkillMarker.of({
			setup: Effect.gen(function* () {
				yield* Effect.sync(() => {
					initSkillMarkerLegacy(pi, makeLegacyStateBridge(persistence.state) as unknown as TauState);
				});
			}),
		});
	}),
);
