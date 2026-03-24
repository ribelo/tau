import { ServiceMap, Effect, Layer } from "effect";

import { PiAPI } from "../effect/pi.js";
import { Persistence } from "./persistence.js";
import { initStatus } from "../status/index.js";

export interface Status {
	readonly setup: Effect.Effect<void>;
}

export const Status = ServiceMap.Service<Status>("Status");

export const StatusLive = Layer.effect(
	Status,
	Effect.gen(function* () {
		const pi = yield* PiAPI;
		const persistence = yield* Persistence;

		return Status.of({
			setup: Effect.sync(() => {
				initStatus(pi, {
					getSnapshot: () => persistence.getSnapshot(),
					update: (patch) => persistence.update(patch),
				});
			}),
		});
	}),
);
