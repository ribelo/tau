import { Option, Schema } from "effect";
import { deepMerge, isRecord } from "./json.js";

export const TAU_PERSISTED_STATE_TYPE = "tau:state";

type PromptModeName = "smart" | "deep" | "rush";

export type TauPersistedState = {
	terminalPrompt?: { enabled?: boolean } | undefined;
	workedFor?: { enabled?: boolean; toolsEnabled?: boolean } | undefined;
	status?: { fetchedAt: number; values: Record<string, { percentLeft: number }> } | undefined;
	promptModes?: {
		activeMode?: PromptModeName | undefined;
		modelsByMode?: Partial<Record<PromptModeName, string>> | undefined;
	} | undefined;
	sandbox?: Record<string, unknown> | undefined;
	agentAwareness?: {
		instructionsInjected?: boolean | undefined;
		lastAgentCount?: number | undefined;
	} | undefined;
};

export function mergePersistedState(
	base: TauPersistedState,
	patch: Partial<TauPersistedState>,
): TauPersistedState {
	return deepMerge(base, patch);
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
	promptModes: Schema.optional(
		Schema.Struct({
			activeMode: Schema.optional(Schema.Literals(["smart", "deep", "rush"])),
			modelsByMode: Schema.optional(
				Schema.Struct({
					smart: Schema.optional(Schema.String),
					deep: Schema.optional(Schema.String),
					rush: Schema.optional(Schema.String),
				}),
			),
		}),
	),
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
	return Option.getOrElse(decoded, (): TauPersistedState => ({})) as TauPersistedState;
}
