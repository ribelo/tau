import { type Effect, ServiceMap } from "effect";

import initTerminalPromptLegacy from "../terminal-prompt/index.js";
import { legacyBridgedLayer } from "./legacy.js";

export interface TerminalPrompt {
	readonly setup: Effect.Effect<void>;
}

export const TerminalPrompt = ServiceMap.Service<TerminalPrompt>("TerminalPrompt");

export const TerminalPromptLive = legacyBridgedLayer(
	TerminalPrompt,
	(pi, state) => initTerminalPromptLegacy(pi, state),
);
