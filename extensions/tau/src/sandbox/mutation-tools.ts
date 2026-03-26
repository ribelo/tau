export const EDIT_TOOL_NAME = "edit";
export const WRITE_TOOL_NAME = "write";
export const APPLY_PATCH_TOOL_NAME = "apply_patch";

export type LegacyMutationToolName = typeof EDIT_TOOL_NAME | typeof WRITE_TOOL_NAME;
export type MutationToolName = LegacyMutationToolName | typeof APPLY_PATCH_TOOL_NAME;

const OPENAI_APPLY_PATCH_PROVIDERS = new Set(["openai", "openai-codex"]);

export function shouldUseApplyPatchForProvider(
	provider: string | null | undefined,
): boolean {
	if (!provider) return false;
	return OPENAI_APPLY_PATCH_PROVIDERS.has(provider);
}

export function isMutationToolName(name: string): name is MutationToolName {
	return name === EDIT_TOOL_NAME || name === WRITE_TOOL_NAME || name === APPLY_PATCH_TOOL_NAME;
}

export function getLegacyMutationToolSelection(
	toolNames: readonly string[],
): LegacyMutationToolName[] {
	const selected: LegacyMutationToolName[] = [];
	for (const toolName of toolNames) {
		if (toolName === EDIT_TOOL_NAME || toolName === WRITE_TOOL_NAME) {
			selected.push(toolName);
		}
	}
	return selected;
}

export function rewriteMutationToolNames(
	toolNames: readonly string[],
	options: {
		readonly useApplyPatch: boolean;
		readonly legacySelection?: readonly LegacyMutationToolName[] | undefined;
	},
): string[] {
	if (!toolNames.some((toolName) => isMutationToolName(toolName))) {
		return [...toolNames];
	}

	const replacement = options.useApplyPatch
		? [APPLY_PATCH_TOOL_NAME]
		: [...(options.legacySelection ?? [EDIT_TOOL_NAME, WRITE_TOOL_NAME])];

	const nextToolNames: string[] = [];
	let insertedReplacement = false;

	for (const toolName of toolNames) {
		if (isMutationToolName(toolName)) {
			if (!insertedReplacement) {
				nextToolNames.push(...replacement);
				insertedReplacement = true;
			}
			continue;
		}
		nextToolNames.push(toolName);
	}

	return nextToolNames;
}
