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
		let currentSnapshot: TauPersistedState = {};

		const publishSnapshot = (next: TauPersistedState): void => {
			currentSnapshot = next;
			Effect.runFork(SubscriptionRef.set(ref, next));
		};

		const replaceSnapshot = (next: TauPersistedState): void => {
			publishSnapshot(next);
		};

		const mergeFromContext = (ctx: ExtensionContext): void => {
			const persisted = loadPersistedState(ctx);
			publishSnapshot(mergePersistedState(currentSnapshot, persisted));
		};

		const updateSnapshot = (patch: Partial<TauPersistedState>): TauPersistedState => {
			const next = mergePersistedState(currentSnapshot, patch);
			publishSnapshot(next);
			pi.appendEntry(TAU_PERSISTED_STATE_TYPE, next);
			return next;
		};

		return Persistence.of({
			getSnapshot: () => currentSnapshot,
			setSnapshot: replaceSnapshot,
			update: (patch) => {
				updateSnapshot(patch);
			},
			getSnapshotEffect: Effect.sync(() => currentSnapshot),
			setSnapshotEffect: (next) => Effect.sync(() => replaceSnapshot(next)),
			updateEffect: (patch) => Effect.sync(() => updateSnapshot(patch)),
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
