import { type Effect, ServiceMap } from "effect";

import initBeadsLegacy from "../beads/index.js";
import { legacyBridgedLayer } from "./legacy.js";

export interface Beads {
	readonly setup: Effect.Effect<void>;
}

export const Beads = ServiceMap.Service<Beads>("Beads");

export const BeadsLive = legacyBridgedLayer(Beads, (pi, state) => initBeadsLegacy(pi, state));
