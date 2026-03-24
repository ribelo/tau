import { type Effect, ServiceMap } from "effect";

import initStatusLegacy from "../status/index.js";
import { legacyBridgedLayer } from "./legacy.js";

export interface Status {
	readonly setup: Effect.Effect<void>;
}

export const Status = ServiceMap.Service<Status>("Status");

export const StatusLive = legacyBridgedLayer(Status, (pi, state) => initStatusLegacy(pi, state));
