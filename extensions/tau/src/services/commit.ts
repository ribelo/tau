import { Context, Effect, Layer } from "effect";

import { PiAPI } from "../effect/pi.js";

// We'll import everything from the old commit/index.js for now,
// but we'll wrap the initialization.
import initCommitLegacy from "../commit/index.js";

export interface Commit {
	readonly setup: Effect.Effect<void>;
}

export const Commit = Context.GenericTag<Commit>("Commit");

export const CommitLive = Layer.effect(
	Commit,
	Effect.gen(function* () {
		const pi = yield* PiAPI;

		return Commit.of({
			setup: Effect.gen(function* () {
				yield* Effect.logInfo("Setting up Commit service");
				yield* Effect.sync(() => {
					initCommitLegacy(pi, {} as any);
				});
			}),
		});
	}),
);
