import { Effect, Layer, Stream } from "effect";
import {
	AgentControl,
	AgentManager,
	AgentError,
	type Status,
	type ControlSpawnOptions,
	type SpawnOptions,
} from "./services.js";
import { AgentRegistry } from "./agent-registry.js";
import { isFinal } from "./status.js";
import type { AgentId, Complexity } from "./types.js";
import { Sandbox } from "../services/sandbox.js";

export const AgentControlLive = Layer.effect(
	AgentControl,
	Effect.gen(function* () {
		const manager = yield* AgentManager;
		const sandbox = yield* Sandbox;

		return AgentControl.of({
			spawn: (opts: ControlSpawnOptions) =>
				Effect.gen(function* () {
					const registry = AgentRegistry.load(opts.cwd);
					const complexity = (opts.complexity || "medium") as Complexity;
					const definition = registry.resolve(opts.agent, complexity);
					
					if (!definition) {
						return yield* Effect.fail(
							new AgentError({ message: `Unknown agent: "${opts.agent}". Available: ${registry.names().join(", ")}` })
						);
					}

					const parentSandboxConfig = yield* sandbox.getConfig;

					return yield* manager.spawn({
						definition,
						message: opts.message,
						depth: 0, // Depth is handled by manager now
						cwd: opts.cwd,
						parentSessionId: opts.parentSessionId,
						parentSandboxConfig,
						parentModel: opts.parentModel,
						approvalBroker: opts.approvalBroker,
						resultSchema: opts.result_schema,
					} satisfies SpawnOptions as SpawnOptions);
				}),
			send: (id: AgentId, message: string, interrupt?: boolean) =>
				Effect.gen(function* () {
					const agent = yield* manager.get(id);
					if (interrupt) {
						yield* agent.interrupt();
					}
					return yield* agent.prompt(message);
				}),
			wait: (ids: AgentId[], timeoutMs = 900000) =>
				Effect.gen(function* () {
					// Default: 15 min, Max: 4 hours
					const timeout = Math.min(Math.max(timeoutMs, 0), 14400000);

					const getStatusMap = Effect.gen(function* () {
						const statusMap: Record<string, Status> = {};
						for (const id of ids) {
							const agentResult = yield* manager.get(id).pipe(Effect.either);
							if (agentResult._tag === "Left") {
								statusMap[id] = { state: "failed", reason: "Not found" };
							} else {
								statusMap[id] = yield* agentResult.right.status;
							}
						}
						return statusMap;
					});

					const allFinal = (statusMap: Record<string, Status>) =>
						Object.values(statusMap).every(isFinal);

					const initialStatusMap = yield* getStatusMap;
					if (allFinal(initialStatusMap) || ids.length === 0) {
						return { status: initialStatusMap, timedOut: false };
					}

					const waitAll = Effect.gen(function* () {
						// Poll until all agents reach final state
						// Using stream subscription for each non-final agent
						const waitForAgent = (id: AgentId) =>
							Effect.gen(function* () {
								const agentResult = yield* manager.get(id).pipe(Effect.either);
								if (agentResult._tag === "Left") return; // Already handled as failed
								
								const currentStatus = yield* agentResult.right.status;
								if (isFinal(currentStatus)) return; // Already done
								
								// Wait for this specific agent to complete
								yield* agentResult.right
									.subscribeStatus()
									.pipe(Stream.filter(isFinal), Stream.take(1), Stream.runDrain);
							});

						// Wait for all agents concurrently
						yield* Effect.all(
							ids.map((id) => waitForAgent(id)),
							{ concurrency: "unbounded" },
						);

						return yield* getStatusMap;
					});

					return yield* waitAll.pipe(
						Effect.timeout(timeout),
						Effect.map((status) => ({ status, timedOut: false })),
						Effect.catchAll(() =>
							getStatusMap.pipe(
								Effect.map((status) => ({ status, timedOut: true })),
							),
						),
					);
				}),
			close: (id: AgentId) => manager.shutdown(id),
			closeAll: manager.shutdownAll,
			list: manager.list,
		});
	}),
);
