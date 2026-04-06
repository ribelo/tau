import { Schema } from "effect";

import {
	PROMPT_MODE_NAMES,
	type PromptModeProfile,
	PromptModeProfileSchema,
} from "../prompt/profile.js";
import { deepMerge } from "../shared/json.js";

const PROMPT_MODE_PRESET_NAMES = ["smart", "deep", "rush", "plan"] as const;

export type PromptModeName = (typeof PROMPT_MODE_NAMES)[number];
export type PromptModePresetName = (typeof PROMPT_MODE_PRESET_NAMES)[number];

export const PromptModeNameSchema = Schema.Literals([...PROMPT_MODE_NAMES]);
export const PromptModePresetNameSchema = Schema.Literals([...PROMPT_MODE_PRESET_NAMES]);

export const PromptSelectorSchema = Schema.Struct({
	mode: PromptModeNameSchema,
});
export type PromptSelector = Schema.Schema.Type<typeof PromptSelectorSchema>;

export const ModeModelAssignmentsSchema = Schema.Struct({
	smart: Schema.optional(Schema.String),
	deep: Schema.optional(Schema.String),
	rush: Schema.optional(Schema.String),
	plan: Schema.optional(Schema.String),
});
export type ModeModelAssignments = Schema.Schema.Type<typeof ModeModelAssignmentsSchema>;

export const ExecutionToolsPolicySchema = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("inherit"),
	}),
	Schema.Struct({
		kind: Schema.Literal("require"),
		tools: Schema.NonEmptyArray(Schema.NonEmptyString),
	}),
	Schema.Struct({
		kind: Schema.Literal("allowlist"),
		tools: Schema.NonEmptyArray(Schema.NonEmptyString),
	}),
]);
export type ExecutionToolsPolicy = Schema.Schema.Type<typeof ExecutionToolsPolicySchema>;

export const ExecutionPolicySchema = Schema.Struct({
	tools: ExecutionToolsPolicySchema,
});
export type ExecutionPolicy = Schema.Schema.Type<typeof ExecutionPolicySchema>;

export const ExecutionPersistedStateSchema = Schema.Struct({
	selector: Schema.optional(PromptSelectorSchema),
	modelsByMode: Schema.optional(ModeModelAssignmentsSchema),
	policy: Schema.optional(ExecutionPolicySchema),
});
export type ExecutionPersistedState = Schema.Schema.Type<typeof ExecutionPersistedStateSchema>;

export const ExecutionSessionStateSchema = Schema.Struct({
	selector: PromptSelectorSchema,
	modelsByMode: Schema.optional(ModeModelAssignmentsSchema),
	policy: ExecutionPolicySchema,
});
export type ExecutionSessionState = Schema.Schema.Type<typeof ExecutionSessionStateSchema>;

export const ExecutionProfileSchema = Schema.Struct({
	selector: PromptSelectorSchema,
	promptProfile: PromptModeProfileSchema,
	policy: ExecutionPolicySchema,
});
export type ExecutionProfile = Schema.Schema.Type<typeof ExecutionProfileSchema>;

const decodeExecutionSessionStateSync = Schema.decodeUnknownSync(ExecutionSessionStateSchema);

export const DEFAULT_PROMPT_SELECTOR: PromptSelector = {
	mode: "default",
};

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
	tools: {
		kind: "inherit",
	},
};

export function normalizeExecutionState(
	state: ExecutionPersistedState | undefined,
): ExecutionSessionState {
	const next: ExecutionSessionState = {
		selector: state?.selector ?? DEFAULT_PROMPT_SELECTOR,
		policy: state?.policy ?? DEFAULT_EXECUTION_POLICY,
		...(state?.modelsByMode === undefined ? {} : { modelsByMode: state.modelsByMode }),
	};
	return decodeExecutionSessionStateSync(next);
}

export function mergeExecutionSessionState(
	base: ExecutionSessionState,
	patch: Partial<ExecutionPersistedState>,
): ExecutionSessionState {
	const merged = deepMerge(base, patch);
	return normalizeExecutionState(merged);
}

export function makeExecutionProfile(input: {
	readonly selector: PromptSelector;
	readonly promptProfile: PromptModeProfile;
	readonly policy: ExecutionPolicy;
}): ExecutionProfile {
	return {
		selector: input.selector,
		promptProfile: input.promptProfile,
		policy: input.policy,
	};
}
