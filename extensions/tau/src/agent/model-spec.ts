import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { Data, Effect, Schema } from "effect";

import type { ModelSpec } from "./types.js";
import { isFullyQualifiedModelId } from "../shared/model-id.js";

export { isFullyQualifiedModelId } from "../shared/model-id.js";

export class ModelSpecError extends Data.TaggedError("ModelSpecError")<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

export const PROMPT_MODE_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;

export const AGENT_THINKING_LEVELS = [...PROMPT_MODE_THINKING_LEVELS, "inherit"] as const;

const PromptModeThinkingLevelSchema = Schema.Literals([...PROMPT_MODE_THINKING_LEVELS]);
const AgentThinkingLevelSchema = Schema.Literals([...AGENT_THINKING_LEVELS]);

const RawModelSpecSchema = Schema.Struct({
	model: Schema.String,
	thinking: Schema.optional(AgentThinkingLevelSchema),
});

export type PromptModeThinkingLevel = Schema.Schema.Type<typeof PromptModeThinkingLevelSchema>;

export function isPromptModeThinkingLevel(value: string): value is PromptModeThinkingLevel {
	return PROMPT_MODE_THINKING_LEVELS.includes(value as PromptModeThinkingLevel);
}

export function validatePromptModeModelId(
	value: string,
	context: string,
): Effect.Effect<string, ModelSpecError> {
	return isFullyQualifiedModelId(value)
		? Effect.succeed(value)
		: Effect.fail(
				new ModelSpecError({
					message: `${context}: model must be "provider/model-id"`,
				}),
			);
}

export function decodeAgentModelSpec(
	input: unknown,
	context: string,
): Effect.Effect<ModelSpec, ModelSpecError> {
	return Schema.decodeUnknownEffect(RawModelSpecSchema)(input).pipe(
		Effect.mapError(
			(cause) =>
				new ModelSpecError({
					message: `${context}: invalid model spec`,
					cause,
				}),
		),
		Effect.flatMap((spec) => {
			if (spec.model.trim().length === 0) {
				return Effect.fail(
					new ModelSpecError({
						message: `${context}.model: must be a non-empty string`,
					}),
				);
			}

			const out: ModelSpec = {
				model: spec.model,
				...(spec.thinking === undefined ? {} : { thinking: spec.thinking as ThinkingLevel | "inherit" }),
			};
			return Effect.succeed(out);
		}),
	);
}
