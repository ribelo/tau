import { Effect, Layer, Stream, Schedule } from "effect";
import {
	AgentControl,
	AgentManager,
	AgentError,
	type Status,
	type ControlSpawnOptions,
	type SpawnOptions,
	type WaitResult,
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
			waitStream: (ids: AgentId[], timeoutMs = 900000, pollIntervalMs = 1000) => {
				const timeout = Math.min(Math.max(timeoutMs, 0), 14400000);
				const pollInterval = Math.max(pollIntervalMs, 250); // Min 250ms

				const getStatusAndTypes = Effect.gen(function* () {
					const statusMap: Record<string, Status> = {};
					const agentTypes: Record<string, string> = {};
					for (const id of ids) {
						const agentResult = yield* manager.get(id).pipe(Effect.either);
						if (agentResult._tag === "Left") {
							statusMap[id] = { state: "failed", reason: "Not found" };
							agentTypes[id] = "unknown";
						} else {
							statusMap[id] = yield* agentResult.right.status;
							agentTypes[id] = agentResult.right.type;
						}
					}
					return { statusMap, agentTypes };
				});

				const allFinal = (statusMap: Record<string, Status>) =>
					Object.values(statusMap).every(isFinal);

				// Create polling effect that emits status
				const pollEffect = Effect.gen(function* () {
					const { statusMap, agentTypes } = yield* getStatusAndTypes;
					return { status: statusMap, timedOut: false, agentTypes } satisfies WaitResult;
				});

				// Create a polling stream: emit status, wait, repeat until all final
				return Stream.repeatEffectWithSchedule(
					pollEffect,
					Schedule.spaced(pollInterval),
				).pipe(
					// Take until all agents are final (inclusive - emit the final state)
					Stream.takeUntil((result) => allFinal(result.status) || ids.length === 0),
					// Apply timeout to the whole stream
					Stream.timeout(timeout),
					Stream.catchAll(() => 
						// On timeout, emit final status with timedOut: true
						Stream.fromEffect(
							getStatusAndTypes.pipe(
								Effect.map(({ statusMap, agentTypes }): WaitResult => ({ 
									status: statusMap, 
									timedOut: true,
									agentTypes,
								}))
							)
						)
					),
				);
			},
			close: (id: AgentId) => manager.shutdown(id),
			closeAll: manager.shutdownAll,
			list: manager.list,
		});
	}),
);
