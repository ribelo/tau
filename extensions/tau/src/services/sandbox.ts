import { Context, Effect, Layer, SubscriptionRef } from "effect";

import { PiAPI } from "../effect/pi.js";
import type { SandboxConfig } from "../sandbox/config.js";
import { SandboxConfigRequired } from "../schemas/config.js";
import { SandboxState } from "./state.js";
import { Persistence } from "./persistence.js";
import { makeLegacyStateBridge } from "./legacy-bridge.js";
import initSandboxLegacy from "../sandbox/index.js";

export interface Sandbox {
	readonly getConfig: Effect.Effect<SandboxConfigRequired>;
	readonly setConfig: (config: Partial<SandboxConfig>) => Effect.Effect<void>;
	readonly setup: Effect.Effect<void>;
}

export const Sandbox = Context.GenericTag<Sandbox>("Sandbox");

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
					// For now, we wrap the legacy init function.
					// We should gradually move logic here.
					initSandboxLegacy(pi, makeLegacyStateBridge(persistence.state) as any);

					// We want to bridge the tau:sandbox:changed event to our state
					pi.events.on("tau:sandbox:changed", (config: unknown) => {
						Effect.runSync(SubscriptionRef.set(state, config as SandboxConfigRequired));
					});
				});
			}),
		});
	}),
);
