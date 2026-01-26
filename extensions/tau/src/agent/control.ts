import { Effect, Layer, Stream } from "effect";
import {
	AgentControl,
	AgentManager,
	type Status,
	type ControlSpawnOptions,
	type SpawnOptions,
} from "./services.js";
import { TaskRegistry } from "./registry.js";
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
					const registry = TaskRegistry.load(opts.cwd);
					const complexity = (opts.complexity || "medium") as Complexity;
					const policy = registry.resolve(opts.type, complexity);
					if (opts.skills) {
						policy.skills.push(...opts.skills);
					}

					const parentSandboxConfig = yield* sandbox.getConfig;

					return yield* manager.spawn({
						type: opts.type,
						policy,
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
			wait: (ids: AgentId[], timeoutMs = 30000) =>
				Effect.gen(function* () {
					const timeout = Math.min(Math.max(timeoutMs, 0), 300000);

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

					const anyFinal = (statusMap: Record<string, Status>) =>
						Object.values(statusMap).some(isFinal);

					const initialStatusMap = yield* getStatusMap;
					if (anyFinal(initialStatusMap) || ids.length === 0) {
						return { status: initialStatusMap, timedOut: false };
					}

					const waitAny = Effect.gen(function* () {
						const streams = [];
						for (const id of ids) {
							const agentResult = yield* manager.get(id).pipe(Effect.either);
							if (agentResult._tag === "Right") {
								streams.push(
									agentResult.right.subscribeStatus().pipe(Stream.filter(isFinal)),
								);
							}
						}
						if (streams.length === 0) return yield* getStatusMap;

						yield* Stream.mergeAll(streams, { concurrency: "unbounded" }).pipe(
							Stream.take(1),
							Stream.runDrain,
						);

						return yield* getStatusMap;
					});

					return yield* waitAny.pipe(
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
			list: manager.list,
		});
	}),
);
