import { type Effect, ServiceMap } from "effect";

import initAgent from "../agent/index.js";
import { legacyPiLayer } from "./legacy.js";

export interface Agent {
	readonly setup: Effect.Effect<void>;
}

export const Agent = ServiceMap.Service<Agent>("Agent");

export const AgentLive = legacyPiLayer(Agent, (pi) => initAgent(pi));
