import { ServiceMap, Effect, Layer, Schema, SubscriptionRef } from "effect";

import { PiAPI } from "../effect/pi.js";
import type { SandboxConfig } from "../sandbox/config.js";
import { SandboxConfigRequired } from "../schemas/config.js";
import { SandboxState } from "./state.js";
import { Persistence } from "./persistence.js";
import { makeLegacyStateBridge } from "./legacy-bridge.js";
import initSandboxLegacy from "../sandbox/index.js";

const isSandboxConfigRequired = Schema.is(SandboxConfigRequired);

export interface Sandbox {
	readonly getConfig: Effect.Effect<SandboxConfigRequired>;
	readonly setConfig: (config: Partial<SandboxConfig>) => Effect.Effect<void>;
	readonly setup: Effect.Effect<void>;
}

export const Sandbox = ServiceMap.Service<Sandbox>("Sandbox");

export const SandboxLive = Layer.effect(
	Sandbox,
	Effect.gen(function* () {
		const pi = yield* PiAPI;
		const state = yield* SandboxState;
		const persistence = yield* Persistence;

		return Sandbox.of({
			getConfig: SubscriptionRef.get(state),
			setConfig: (patch) =>
				SubscriptionRef.update(state, (current) => ({
					...current,
					...patch,
				})),
			setup: Effect.gen(function* () {
				yield* Effect.sync(() => {
					initSandboxLegacy(pi, makeLegacyStateBridge(persistence));

					pi.events.on("tau:sandbox:changed", (config: unknown) => {
						if (isSandboxConfigRequired(config)) {
							Effect.runSync(SubscriptionRef.set(state, config));
						}
					});
				});
			}),
		});
	}),
);
