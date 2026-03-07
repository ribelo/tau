import { ServiceMap, Effect, Layer } from "effect";

import { PiAPI } from "../effect/pi.js";

// We'll import everything from the old commit/index.js for now,
// but we'll wrap the initialization.
import initCommitLegacy from "../commit/index.js";

export interface Commit {
	readonly setup: Effect.Effect<void>;
}

export const Commit = ServiceMap.Service<Commit>("Commit");

export const CommitLive = Layer.effect(
	Commit,
	Effect.gen(function* () {
		const pi = yield* PiAPI;

		return Commit.of({
			setup: Effect.gen(function* () {
				yield* Effect.sync(() => {
					initCommitLegacy(pi);
				});
			}),
		});
	}),
);
