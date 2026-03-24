import { type Effect, ServiceMap } from "effect";

import initEditorLegacy from "../editor/index.js";
import { legacyBridgedLayer } from "./legacy.js";

export interface Editor {
	readonly setup: Effect.Effect<void>;
}

export const Editor = ServiceMap.Service<Editor>("Editor");

export const EditorLive = legacyBridgedLayer(Editor, (pi, state) => initEditorLegacy(pi, state));
