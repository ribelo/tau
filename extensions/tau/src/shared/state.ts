import { Option, Schema } from "effect";
import { deepMerge, isRecord } from "./json.js";
import {
	normalizeExecutionState,
	ExecutionPersistedStateSchema,
	type ExecutionPersistedState,
} from "../execution/schema.js";

export const TAU_PERSISTED_STATE_TYPE = "tau:state";

export type TauPersistedState = {
	terminalPrompt?: { enabled?: boolean } | undefined;
	workedFor?: { enabled?: boolean; toolsEnabled?: boolean } | undefined;
	status?: { fetchedAt: number; values: Record<string, { percentLeft: number }> } | undefined;
	execution?: ExecutionPersistedState | undefined;
	sandbox?: Record<string, unknown> | undefined;
	agentAwareness?: {
		instructionsInjected?: boolean | undefined;
		lastAgentCount?: number | undefined;
	} | undefined;
};

function normalizePersistedState(state: TauPersistedState): TauPersistedState {
	if (state.execution === undefined) {
		return state;
	}

	const normalizedExecution = normalizeExecutionState(state.execution);
	return {
		...state,
		execution: normalizedExecution,
	};
}

export function mergePersistedState(
	base: TauPersistedState,
	patch: Partial<TauPersistedState>,
): TauPersistedState {
	return normalizePersistedState(deepMerge(base, patch));
}

const FiniteNumber = Schema.Number.check(Schema.isFinite());

const TauPersistedStateSchema = Schema.Struct({
	terminalPrompt: Schema.optional(
		Schema.Struct({
			enabled: Schema.optional(Schema.Boolean),
		}),
	),
	workedFor: Schema.optional(
		Schema.Struct({
			enabled: Schema.optional(Schema.Boolean),
			toolsEnabled: Schema.optional(Schema.Boolean),
		}),
	),
	status: Schema.optional(
		Schema.Struct({
			fetchedAt: FiniteNumber,
			values: Schema.Record(Schema.String, Schema.Struct({
				percentLeft: FiniteNumber,
			})),
		}),
	),
	execution: Schema.optional(ExecutionPersistedStateSchema),
	sandbox: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
	agentAwareness: Schema.optional(
		Schema.Struct({
			instructionsInjected: Schema.optional(Schema.Boolean),
			lastAgentCount: Schema.optional(FiniteNumber),
		}),
	),
});

const decodePersistedState = Schema.decodeUnknownOption(TauPersistedStateSchema);

export function loadPersistedState(ctx: {
	sessionManager: { getEntries: () => unknown[] };
}): TauPersistedState {
	const entries = ctx.sessionManager.getEntries();
	const last = entries
		.filter(
			(e): e is { type: "custom"; customType: string; data: unknown } =>
				isRecord(e) &&
				e["type"] === "custom" &&
				e["customType"] === TAU_PERSISTED_STATE_TYPE,
		)
		.pop();

	const decoded = decodePersistedState(last?.data);
	const state = Option.getOrElse(decoded, (): TauPersistedState => ({})) as TauPersistedState;
	return normalizePersistedState(state);
}
