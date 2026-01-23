import { Context, Effect, Layer } from "effect";

import { PiAPI } from "../effect/pi.js";
import { Persistence } from "./persistence.js";
import { makeLegacyStateBridge } from "./legacy-bridge.js";

// We'll import everything from the old editor/index.js for now,
// but we'll wrap the initialization.
import initEditorLegacy from "../editor/index.js";

export interface Editor {
	readonly setup: Effect.Effect<void>;
}

export const Editor = Context.GenericTag<Editor>("Editor");

export const EditorLive = Layer.effect(
	Editor,
	Effect.gen(function* () {
		const pi = yield* PiAPI;
		const persistence = yield* Persistence;

		return Editor.of({
			setup: Effect.gen(function* () {
				yield* Effect.sync(() => {
					initEditorLegacy(pi, makeLegacyStateBridge(persistence.state) as any);
				});
			}),
		});
	}),
);
