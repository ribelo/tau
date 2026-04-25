import { Schema } from "effect";

import { ExecutionProfileSchema } from "../execution/schema.js";
import { SandboxConfigRequired as SandboxProfileSchema } from "../schemas/config.js";

export const RalphMaxIterationsMutationSchema = Schema.Struct({
	kind: Schema.Literal("maxIterations"),
	value: Schema.Number,
});

export const RalphItemsPerIterationMutationSchema = Schema.Struct({
	kind: Schema.Literal("itemsPerIteration"),
	value: Schema.Number,
});

export const RalphReflectEveryMutationSchema = Schema.Struct({
	kind: Schema.Literal("reflectEvery"),
	value: Schema.Number,
});

export const RalphReflectInstructionsMutationSchema = Schema.Struct({
	kind: Schema.Literal("reflectInstructions"),
	value: Schema.String,
});

export const RalphCapabilityContractToolsMutationSchema = Schema.Struct({
	kind: Schema.Literal("capabilityContractTools"),
	activeNames: Schema.Array(Schema.NonEmptyString),
});

export const RalphCapabilityContractAgentsMutationSchema = Schema.Struct({
	kind: Schema.Literal("capabilityContractAgents"),
	enabledNames: Schema.Array(Schema.NonEmptyString),
});

export const RalphExecutionProfileMutationSchema = Schema.Struct({
	kind: Schema.Literal("executionProfile"),
	profile: ExecutionProfileSchema,
});

export const RalphSandboxProfileMutationSchema = Schema.Struct({
	kind: Schema.Literal("sandboxProfile"),
	profile: SandboxProfileSchema,
});

export const RalphConfigMutationSchema = Schema.Union([
	RalphMaxIterationsMutationSchema,
	RalphItemsPerIterationMutationSchema,
	RalphReflectEveryMutationSchema,
	RalphReflectInstructionsMutationSchema,
	RalphCapabilityContractToolsMutationSchema,
	RalphCapabilityContractAgentsMutationSchema,
	RalphExecutionProfileMutationSchema,
	RalphSandboxProfileMutationSchema,
]);

export type RalphConfigMutation = Schema.Schema.Type<typeof RalphConfigMutationSchema>;

export const RalphConfigMutationListSchema = Schema.Array(RalphConfigMutationSchema);
