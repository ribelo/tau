import { ServiceMap, Effect, Layer, Stream, SubscriptionRef } from "effect";

import { PiAPI } from "../effect/pi.js";
import {
	TAU_PERSISTED_STATE_TYPE,
	loadPersistedState,
	mergePersistedState,
	type TauPersistedState,
} from "../shared/state.js";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export class Persistence extends ServiceMap.Service<
	Persistence,
	{
		readonly getSnapshot: () => TauPersistedState;
		readonly setSnapshot: (next: TauPersistedState) => void;
		readonly update: (patch: Partial<TauPersistedState>) => void;
		readonly getSnapshotEffect: Effect.Effect<TauPersistedState>;
		readonly setSnapshotEffect: (next: TauPersistedState) => Effect.Effect<void>;
		readonly updateEffect: (patch: Partial<TauPersistedState>) => Effect.Effect<TauPersistedState>;
		readonly changes: Stream.Stream<TauPersistedState>;
		readonly setup: Effect.Effect<void>;
	}
>()("Persistence") {}

export const PersistenceLive = Layer.effect(
	Persistence,
	Effect.gen(function* () {
		const pi = yield* PiAPI;
		const ref = yield* SubscriptionRef.make<TauPersistedState>({});

		const setSnapshot = (next: TauPersistedState): void => {
			Effect.runSync(SubscriptionRef.set(ref, next));
		};

		const mergeFromContext = (ctx: ExtensionContext): void => {
			const persisted = loadPersistedState(ctx);
			Effect.runSync(SubscriptionRef.update(ref, (current) => mergePersistedState(current, persisted)));
		};

		const updateSnapshot = (patch: Partial<TauPersistedState>): TauPersistedState => {
			const next = Effect.runSync(SubscriptionRef.updateAndGet(ref, (current) => mergePersistedState(current, patch)));
			pi.appendEntry(TAU_PERSISTED_STATE_TYPE, next);
			return next;
		};

		return Persistence.of({
			getSnapshot: () => SubscriptionRef.getUnsafe(ref),
			setSnapshot,
			update: (patch) => {
				updateSnapshot(patch);
			},
			getSnapshotEffect: SubscriptionRef.get(ref),
			setSnapshotEffect: (next) => SubscriptionRef.set(ref, next),
			updateEffect: (patch) => SubscriptionRef.updateAndGet(ref, (current) => mergePersistedState(current, patch)),
			changes: SubscriptionRef.changes(ref),
			setup: Effect.sync(() => {
				const mergePersistedFromContext = (_event: unknown, ctx: ExtensionContext) => {
					mergeFromContext(ctx);
				};

				pi.on("session_start", mergePersistedFromContext);
				pi.on("session_switch", mergePersistedFromContext);
			}),
		});
	}),
);
