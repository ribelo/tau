import { type Effect, ServiceMap } from "effect";

import initWorkedForLegacy from "../worked-for/index.js";
import { legacyBridgedLayer } from "./legacy.js";

export interface WorkedFor {
	readonly setup: Effect.Effect<void>;
}

export const WorkedFor = ServiceMap.Service<WorkedFor>("WorkedFor");

export const WorkedForLive = legacyBridgedLayer(
	WorkedFor,
	(pi, state) => initWorkedForLegacy(pi, state),
);
