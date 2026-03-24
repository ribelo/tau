import { Effect, Exit, Layer, Schema, ServiceMap, Stream, SubscriptionRef } from "effect";

import { PiAPI } from "../effect/pi.js";
import type { SandboxConfig } from "../sandbox/config.js";
import { SandboxConfigRequired } from "../schemas/config.js";
import { SandboxState } from "./state.js";
import { Persistence } from "./persistence.js";
import { makeLegacyStateBridge } from "./legacy-bridge.js";
import initSandboxLegacy from "../sandbox/index.js";

const decodeSandboxConfigRequired = Schema.decodeUnknownExit(SandboxConfigRequired);

export interface Sandbox {
	readonly getConfig: Effect.Effect<SandboxConfigRequired>;
	readonly changes: Stream.Stream<SandboxConfigRequired>;
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
		let currentConfig = yield* SubscriptionRef.get(state);

		const replaceConfig = (next: SandboxConfigRequired): Effect.Effect<void> =>
			Effect.gen(function* () {
				currentConfig = next;
				yield* SubscriptionRef.set(state, next);
			});

		return Sandbox.of({
			getConfig: Effect.sync(() => currentConfig),
			changes: SubscriptionRef.changes(state),
			setConfig: (patch) =>
				Effect.gen(function* () {
					const next: SandboxConfigRequired = {
						...currentConfig,
						...patch,
					};
					yield* replaceConfig(next);
				}),
			setup: Effect.gen(function* () {
				yield* Effect.sync(() => {
					initSandboxLegacy(
						pi,
						makeLegacyStateBridge({
							getSnapshotSync: persistence.getSnapshot,
							setSnapshotSync: persistence.setSnapshot,
						}),
					);

					pi.events.on("tau:sandbox:changed", (config: unknown) => {
						const decoded = decodeSandboxConfigRequired(config);
						if (Exit.isSuccess(decoded)) {
							currentConfig = decoded.value;
							Effect.runFork(SubscriptionRef.set(state, decoded.value));
						}
					});
				});
			}),
		});
	}),
);
