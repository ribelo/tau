import { Context, Effect, Layer } from "effect";

import { PiAPI } from "../effect/pi.js";
import { Persistence } from "./persistence.js";
import { makeLegacyStateBridge } from "./legacy-bridge.js";

// We'll import everything from the old terminal-prompt/index.js for now,
// but we'll wrap the initialization.
import initTerminalPromptLegacy from "../terminal-prompt/index.js";

export interface TerminalPrompt {
	readonly setup: Effect.Effect<void>;
}

export const TerminalPrompt = Context.GenericTag<TerminalPrompt>("TerminalPrompt");

export const TerminalPromptLive = Layer.effect(
	TerminalPrompt,
	Effect.gen(function* () {
		const pi = yield* PiAPI;
		const persistence = yield* Persistence;

		return TerminalPrompt.of({
			setup: Effect.gen(function* () {
				yield* Effect.sync(() => {
					initTerminalPromptLegacy(pi, makeLegacyStateBridge(persistence.state) as any);
				});
			}),
		});
	}),
);
