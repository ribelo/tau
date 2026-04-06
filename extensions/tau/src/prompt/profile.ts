import { Schema } from "effect";

import {
	PROMPT_MODE_THINKING_LEVELS,
	type PromptModeThinkingLevel,
} from "../agent/model-spec.js";

export const PROMPT_MODE_NAMES = ["default", "smart", "deep", "rush", "plan"] as const;

export type PromptProfileMode = (typeof PROMPT_MODE_NAMES)[number];

export type PromptModeProfile = {
	readonly mode: PromptProfileMode;
	readonly model: string;
	readonly thinking: PromptModeThinkingLevel;
};

export const PromptProfileModeSchema = Schema.Literals([...PROMPT_MODE_NAMES]);

export const PromptModeProfileSchema = Schema.Struct({
	mode: PromptProfileModeSchema,
	model: Schema.String,
	thinking: Schema.Literals([...PROMPT_MODE_THINKING_LEVELS]),
});

export function formatModelId(model: {
	readonly provider: string;
	readonly id: string;
}): string {
	return `${model.provider}/${model.id}`;
}

export function readModelId(
	model:
		| {
				readonly provider: string;
				readonly id: string;
		  }
		| undefined,
): string | undefined {
	if (model === undefined) {
		return undefined;
	}
	return formatModelId(model);
}
