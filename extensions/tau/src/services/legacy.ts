import { Effect, Layer, type ServiceMap } from "effect";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { PiAPI } from "../effect/pi.js";
import type { TauState } from "../shared/state.js";
import { Persistence } from "./persistence.js";
import { makeLegacyStateBridge } from "./legacy-bridge.js";

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
): Layer.Layer<Id, never, PiAPI | Persistence> {
	return Layer.effect(
		tag,
		Effect.gen(function* () {
			const pi = yield* PiAPI;
			const persistence = yield* Persistence;
			return tag.of({
				setup: Effect.sync(() => initFn(pi, makeLegacyStateBridge(persistence))),
			} as S);
		}),
	);
}
