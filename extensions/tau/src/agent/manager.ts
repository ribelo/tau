import { Effect, Layer, Ref, HashMap, Option } from "effect";
import {
	AgentManager,
	AgentConfig,
	type Agent,
	type AgentInfo,
	AgentLimitReached,
	AgentDepthExceeded,
	AgentNotFound,
} from "./services.js";
import type { AgentId } from "./types.js";
import { AgentWorker } from "./worker.js";

export const AgentManagerLive = Layer.effect(
	AgentManager,
	Effect.gen(function* () {
		const config = yield* AgentConfig;
		const agentsRef = yield* Ref.make(HashMap.empty<AgentId, Agent>());
		const depthMapRef = yield* Ref.make(HashMap.empty<string, number>());

		return AgentManager.of({
			spawn: (opts) =>
				Effect.gen(function* () {
					const agents = yield* Ref.get(agentsRef);
					if (HashMap.size(agents) >= config.maxThreads) {
						return yield* Effect.fail(
							new AgentLimitReached({ max: config.maxThreads }),
						);
					}

					const depthMap = yield* Ref.get(depthMapRef);
					const parentDepth = Option.getOrElse(
						HashMap.get(depthMap, opts.parentSessionId),
						() => 0,
					);
					const depth = parentDepth + 1;

					if (depth > config.maxDepth) {
						return yield* Effect.fail(
							new AgentDepthExceeded({ max: config.maxDepth }),
						);
					}

					const agent = yield* AgentWorker.make({
						definition: opts.definition,
						depth: depth,
						cwd: opts.cwd,
						parentSessionId: opts.parentSessionId,
						parentSandboxConfig: opts.parentSandboxConfig,
						parentModel: opts.parentModel,
						approvalBroker: opts.approvalBroker,
						resultSchema: opts.resultSchema,
					});

					const id = agent.id;
					yield* Ref.update(agentsRef, (map) => HashMap.set(map, id, agent));
					yield* Ref.update(depthMapRef, (map) => HashMap.set(map, id, depth));

					// Initial prompt
					yield* agent.prompt(opts.message);

					return id;
				}),
			get: (id) =>
				Effect.gen(function* () {
					const agents = yield* Ref.get(agentsRef);
					const agent = HashMap.get(agents, id);
					if (Option.isNone(agent)) {
						return yield* Effect.fail(new AgentNotFound({ id }));
					}
					return agent.value;
				}),
			list: Effect.gen(function* () {
				const agents = yield* Ref.get(agentsRef);
				const infos: AgentInfo[] = [];
				for (const agent of HashMap.values(agents)) {
					const status = yield* agent.status;
					infos.push({
						id: agent.id,
						type: agent.type,
						status,
					});
				}
				return infos;
			}),
			shutdown: (id) =>
				Effect.gen(function* () {
					const agents = yield* Ref.get(agentsRef);
					const agent = HashMap.get(agents, id);
					if (Option.isNone(agent)) {
						return yield* Effect.fail(new AgentNotFound({ id }));
					}
					yield* agent.value.shutdown();
					yield* Ref.update(agentsRef, (map) => HashMap.remove(map, id));
					yield* Ref.update(depthMapRef, (map) => HashMap.remove(map, id));
				}),
		});
	}),
);
