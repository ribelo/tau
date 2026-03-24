import { Effect, Layer, ServiceMap } from "effect";

import type { TauState } from "../shared/state.js";
import { Persistence } from "./persistence.js";
import { makeLegacyStateBridge } from "./legacy-bridge.js";

export class LegacyState extends ServiceMap.Service<LegacyState, TauState>()("LegacyState") {}

export const LegacyStateLive = Layer.effect(
	LegacyState,
	Effect.gen(function* () {
		const persistence = yield* Persistence;

		return makeLegacyStateBridge({
			getSnapshotSync: persistence.getSnapshot,
			setSnapshotSync: persistence.setSnapshot,
		});
	}),
);
