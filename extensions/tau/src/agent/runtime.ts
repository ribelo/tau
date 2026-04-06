import { Effect, Layer, ServiceMap } from "effect";

import { AgentControl } from "./services.js";
import { createAgentToolDef, type AgentToolContext, type AgentToolDef } from "./tool.js";
import type { CuratedMemory } from "../services/curated-memory.js";
import type { ExecutionState } from "../services/execution-state.js";

export type RunAgentControlPromise = <A, E, R extends AgentControl | CuratedMemory | ExecutionState>(
	effect: Effect.Effect<A, E, R>,
) => Promise<A>;

export interface AgentRuntimeBridgeService {
	readonly runPromise: RunAgentControlPromise;
	readonly closeAll: () => Promise<void>;
}

export class AgentRuntimeBridge extends ServiceMap.Service<
	AgentRuntimeBridge,
	AgentRuntimeBridgeService
>()("AgentRuntimeBridge") {}

export const AgentRuntimeBridgeLive = (runPromise: RunAgentControlPromise) =>
	Layer.succeed(
		AgentRuntimeBridge,
		AgentRuntimeBridge.of({
			runPromise,
			closeAll: () =>
				runPromise(
					Effect.gen(function* () {
						const control = yield* AgentControl;
						yield* control.closeAll;
					}),
				),
		}),
	);

export function createWorkerAgentTool(
	runPromise: RunAgentControlPromise,
	context: AgentToolContext,
	description: string,
): AgentToolDef {
	return createAgentToolDef(
		(effect) => runPromise(effect),
		() => context,
		description,
	);
}
