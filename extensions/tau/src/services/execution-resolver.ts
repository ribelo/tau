import type {
	ExecutionSessionState,
	PromptModePresetName,
	PromptSelector,
} from "../execution/schema.js";

export function resolvePromptSelectorMode(
	selector: PromptSelector | undefined,
): "default" | "smart" | "deep" | "rush" | "plan" {
	return selector?.mode ?? "default";
}

export function resolveSessionMode(
	state: ExecutionSessionState | undefined,
): "default" | "smart" | "deep" | "rush" | "plan" {
	return resolvePromptSelectorMode(state?.selector);
}

export function resolveModeModelCandidates(
	state: ExecutionSessionState,
	mode: PromptModePresetName,
	presetModel: string,
): readonly string[] {
	const assigned = state.modelsByMode?.[mode];
	if (assigned === undefined || assigned === presetModel) {
		return [presetModel];
	}
	return [assigned, presetModel];
}
