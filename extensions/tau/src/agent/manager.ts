import { Effect, Layer, Ref, HashMap, Option } from "effect";
import {
	AgentManager,
	AgentConfig,
	type Agent,
	type AgentInfo,
	AgentLimitReached,
	AgentDepthExceeded,
	AgentNotFound,
	AgentAccessDenied,
} from "./services.js";
import type { AgentId } from "./types.js";
import { AgentWorker } from "./worker.js";

const ORCHESTRATOR_PARENT = "orchestrator" as AgentId;

const canMutate = (
	parentMapRef: Ref.Ref<HashMap.HashMap<AgentId, AgentId>>,
	targetId: AgentId,
	requesterAgentId?: AgentId,
): Effect.Effect<boolean> =>
	Effect.gen(function* () {
		if (requesterAgentId === undefined) {
			return true;
		}
		const parentMap = yield* Ref.get(parentMapRef);
		const parentId = Option.getOrElse(HashMap.get(parentMap, targetId), () => ORCHESTRATOR_PARENT);
		return parentId === requesterAgentId;
	});

const collectDescendants = (
	parentMap: HashMap.HashMap<AgentId, AgentId>,
	rootId: AgentId,
): AgentId[] => {
	const childrenByParent = new Map<AgentId, AgentId[]>();
	for (const [child, parent] of parentMap) {
		const list = childrenByParent.get(parent) ?? [];
		list.push(child);
		childrenByParent.set(parent, list);
	}

	const result: AgentId[] = [];
	const stack: AgentId[] = [rootId];
	const seen = new Set<AgentId>();
	while (stack.length > 0) {
		const current = stack.pop();
		if (current === undefined || seen.has(current)) {
			continue;
		}
		seen.add(current);
		result.push(current);
		const children = childrenByParent.get(current) ?? [];
		for (const child of children) {
			stack.push(child);
		}
	}

	return result;
};

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
			canMutate: (id, requesterAgentId) =>
				withGate(
					Effect.gen(function* () {
						const agents = yield* Ref.get(agentsRef);
						const agent = HashMap.get(agents, id);
						if (Option.isNone(agent)) {
							return yield* Effect.fail(new AgentNotFound({ id }));
						}
						return yield* canMutate(parentMapRef, id, requesterAgentId);
					}),
				),
			shutdown: (id, requesterAgentId) =>
				withGate(
					Effect.gen(function* () {
						const agents = yield* Ref.get(agentsRef);
						const agent = HashMap.get(agents, id);
						if (Option.isNone(agent)) {
							return yield* Effect.fail(new AgentNotFound({ id }));
						}

						const parentMap = yield* Ref.get(parentMapRef);
						const parentId = Option.getOrElse(HashMap.get(parentMap, id), () => ORCHESTRATOR_PARENT);
						const allowed = yield* canMutate(parentMapRef, id, requesterAgentId);
						if (!allowed && requesterAgentId !== undefined) {
							return yield* Effect.fail(
								new AgentAccessDenied({ id, requesterId: requesterAgentId, parentId }),
							);
						}

						const idsToClose = collectDescendants(parentMap, id);
						for (const closedId of idsToClose) {
							const currentAgents = yield* Ref.get(agentsRef);
							const currentAgent = HashMap.get(currentAgents, closedId);
							if (Option.isSome(currentAgent)) {
								yield* currentAgent.value.shutdown();
							}
							yield* Ref.update(agentsRef, (map) => HashMap.remove(map, closedId));
							yield* Ref.update(depthMapRef, (map) => HashMap.remove(map, closedId));
							yield* Ref.update(parentMapRef, (map) => HashMap.remove(map, closedId));
						}

						return idsToClose;
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
