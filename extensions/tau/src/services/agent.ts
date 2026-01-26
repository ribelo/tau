import { Context, Effect, Layer } from "effect";
import { PiAPI } from "../effect/pi.js";
import initAgent from "../agent/index.js";

export interface Agent {
	readonly setup: Effect.Effect<void>;
}

export const Agent = Context.GenericTag<Agent>("Agent");

export const AgentLive = Layer.effect(
	Agent,
	Effect.gen(function* () {
		const pi = yield* PiAPI;

		return Agent.of({
			setup: Effect.gen(function* () {
				yield* Effect.sync(() => {
					initAgent(pi);
				});
			}),
		});
	}),
);
