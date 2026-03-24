import { type Effect, ServiceMap } from "effect";

import initBeadsLegacy from "../beads/index.js";
import { createState } from "../shared/state.js";
import { legacyPiLayer } from "./legacy.js";

export interface Beads {
	readonly setup: Effect.Effect<void>;
}

export const Beads = ServiceMap.Service<Beads>("Beads");

export const BeadsLive = legacyPiLayer(Beads, (pi) => initBeadsLegacy(pi, createState()));
