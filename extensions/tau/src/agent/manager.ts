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
		const parentMapRef = yield* Ref.make(HashMap.empty<AgentId, AgentId>());
		const operationGate = yield* Effect.makeSemaphore(1);
		const withGate = operationGate.withPermits(1);

		return AgentManager.of({
			spawn: (opts) =>
				withGate(
					Effect.gen(function* () {
						const agents = yield* Ref.get(agentsRef);
						if (HashMap.size(agents) >= config.maxThreads) {
							return yield* Effect.fail(
								new AgentLimitReached({ max: config.maxThreads }),
							);
						}

						const depthMap = yield* Ref.get(depthMapRef);
						const parentDepth = opts.parentAgentId !== undefined
							? Option.getOrElse(HashMap.get(depthMap, opts.parentAgentId), () => 0)
							: 0;
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
							modelRegistry: opts.modelRegistry,
							resultSchema: opts.resultSchema,
						});

						const id = agent.id;
						const parentAgentId = opts.parentAgentId;
						yield* Ref.update(agentsRef, (map) => HashMap.set(map, id, agent));
						yield* Ref.update(depthMapRef, (map) => HashMap.set(map, id, depth));
						if (parentAgentId !== undefined) {
							yield* Ref.update(parentMapRef, (map) => HashMap.set(map, id, parentAgentId));
						}

						// Initial prompt
						yield* agent.prompt(opts.message);

						return id;
					}),
				),
			get: (id) =>
				Effect.gen(function* () {
					const agents = yield* Ref.get(agentsRef);
					const agent = HashMap.get(agents, id);
					if (Option.isNone(agent)) {
						return yield* Effect.fail(new AgentNotFound({ id }));
					}
					return agent.value;
				}),
			list: withGate(
				Effect.gen(function* () {
					const agents = yield* Ref.get(agentsRef);
					const parentMap = yield* Ref.get(parentMapRef);
					const infos: AgentInfo[] = [];
					for (const agent of HashMap.values(agents)) {
						const status = yield* agent.status;
						const parentAgentId = Option.getOrUndefined(HashMap.get(parentMap, agent.id));
						infos.push({
							id: agent.id,
							type: agent.type,
							status,
							parentAgentId,
						});
					}
					return infos;
				}),
			),
			shutdown: (id) =>
				withGate(
					Effect.gen(function* () {
						const agents = yield* Ref.get(agentsRef);
						const agent = HashMap.get(agents, id);
						if (Option.isNone(agent)) {
							return yield* Effect.fail(new AgentNotFound({ id }));
						}
						yield* agent.value.shutdown();
						yield* Ref.update(agentsRef, (map) => HashMap.remove(map, id));
						yield* Ref.update(depthMapRef, (map) => HashMap.remove(map, id));
						yield* Ref.update(parentMapRef, (map) => HashMap.remove(map, id));
					}),
				),
			shutdownAll: withGate(
				Effect.gen(function* () {
					const agents = yield* Ref.get(agentsRef);
					for (const agent of HashMap.values(agents)) {
						yield* agent.shutdown().pipe(Effect.ignore);
					}
					yield* Ref.set(agentsRef, HashMap.empty());
					yield* Ref.set(depthMapRef, HashMap.empty());
					yield* Ref.set(parentMapRef, HashMap.empty());
				}),
			),
		});
	}),
);
