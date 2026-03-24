import { ServiceMap, Effect, Layer } from "effect";

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
		readonly setup: Effect.Effect<void>;
	}
>()("Persistence") {}

export const PersistenceLive = Layer.effect(
	Persistence,
	Effect.gen(function* () {
		const pi = yield* PiAPI;
		let snapshot: TauPersistedState = {};

		const mergeFromContext = (ctx: ExtensionContext): void => {
			const persisted = loadPersistedState(ctx);
			snapshot = mergePersistedState(snapshot, persisted);
		};

		return {
			getSnapshot: () => snapshot,
			setSnapshot: (next) => {
				snapshot = next;
			},
			update: (patch) => {
				snapshot = mergePersistedState(snapshot, patch);
				pi.appendEntry(TAU_PERSISTED_STATE_TYPE, snapshot);
			},
			setup: Effect.sync(() => {
				pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
					mergeFromContext(ctx);
				});
				pi.on("session_switch", (_event: unknown, ctx: ExtensionContext) => {
					mergeFromContext(ctx);
				});
			}),
		};
	}),
);
