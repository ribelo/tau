import { type Effect, ServiceMap } from "effect";

import initExaLegacy from "../exa/index.js";
import { legacyPiLayer } from "./legacy.js";

export interface Exa {
	readonly setup: Effect.Effect<void>;
}

export const Exa = ServiceMap.Service<Exa>("Exa");

export const ExaLive = legacyPiLayer(Exa, (pi) => initExaLegacy(pi));
