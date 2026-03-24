import { Effect, Layer, type ServiceMap } from "effect";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { PiAPI } from "../effect/pi.js";
import type { TauState } from "../shared/state.js";
import { LegacyState } from "./legacy-state.js";

type LegacySetup = { readonly setup: Effect.Effect<void> };

export function legacyPiLayer<Id, S extends LegacySetup>(
	tag: ServiceMap.Service<Id, S>,
	initFn: (pi: ExtensionAPI) => void,
): Layer.Layer<Id, never, PiAPI> {
	return Layer.effect(
		tag,
		Effect.gen(function* () {
			const pi = yield* PiAPI;
			return tag.of({ setup: Effect.sync(() => initFn(pi)) } as S);
		}),
	);
}

export function legacyBridgedLayer<Id, S extends LegacySetup>(
	tag: ServiceMap.Service<Id, S>,
	initFn: (pi: ExtensionAPI, state: TauState) => void,
): Layer.Layer<Id, never, PiAPI | LegacyState> {
	return Layer.effect(
		tag,
		Effect.gen(function* () {
			const pi = yield* PiAPI;
			const state = yield* LegacyState;
			return tag.of({
				setup: Effect.sync(() => initFn(pi, state)),
			} as S);
		}),
	);
}
