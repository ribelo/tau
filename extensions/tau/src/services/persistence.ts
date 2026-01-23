import { Context, Effect, Layer, SubscriptionRef } from "effect";

import { PiAPI } from "../effect/pi.js";
import { TAU_PERSISTED_STATE_TYPE, loadPersistedState, type TauPersistedState } from "../shared/state.js";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export class Persistence extends Context.Tag("Persistence")<
	Persistence,
	{
		readonly state: SubscriptionRef.SubscriptionRef<TauPersistedState>;
		readonly update: (patch: Partial<TauPersistedState>) => Effect.Effect<void>;
		readonly setup: Effect.Effect<void>;
	}
>() {}

export const PersistenceLive = Layer.effect(
	Persistence,
	Effect.gen(function* () {
		const pi = yield* PiAPI;
		const state = yield* SubscriptionRef.make<TauPersistedState>({});

		return {
			state,
			update: (patch) =>
				Effect.gen(function* () {
					yield* SubscriptionRef.update(state, (current) => ({
						...current,
						...patch,
					}));
					const current = yield* SubscriptionRef.get(state);
					yield* Effect.sync(() => pi.appendEntry(TAU_PERSISTED_STATE_TYPE, current));
				}),
			setup: Effect.gen(function* () {
				yield* Effect.sync(() => {
					pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
						const persisted = loadPersistedState(ctx);
						Effect.runSync(SubscriptionRef.set(state, persisted));
					});
				});
			}),
		};
	}),
);
