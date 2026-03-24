import { type Effect, ServiceMap } from "effect";

import initSkillMarkerLegacy from "../skill-marker/index.js";
import { legacyBridgedLayer } from "./legacy.js";

export interface SkillMarker {
	readonly setup: Effect.Effect<void>;
}

export const SkillMarker = ServiceMap.Service<SkillMarker>("SkillMarker");

export const SkillMarkerLive = legacyBridgedLayer(
	SkillMarker,
	(pi, state) => initSkillMarkerLegacy(pi, state),
);
