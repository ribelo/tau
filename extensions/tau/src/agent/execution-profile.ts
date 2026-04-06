import { Effect } from "effect";

import {
	type ExecutionPolicy,
	type ExecutionProfile,
	type ExecutionSessionState,
	type PromptModePresetName,
	makeExecutionProfile,
} from "../execution/schema.js";
import {
	isPromptModePresetName,
	resolvePromptModePresets,
} from "../prompt/modes.js";
import { resolveModeModelCandidates } from "../services/execution-resolver.js";
import {
	type PromptModeThinkingLevel,
	isFullyQualifiedModelId,
	isPromptModeThinkingLevel,
} from "./model-spec.js";
import { AgentError } from "./services.js";
import type { AgentDefinition, ModelSpec } from "./types.js";

export type ResolvedAgentExecution = {
	readonly definition: AgentDefinition;
	readonly executionState: ExecutionSessionState;
	readonly executionProfile: ExecutionProfile;
};

type ResolveAgentExecutionInput = {
	readonly definition: AgentDefinition;
	readonly cwd: string;
	readonly parentExecutionState: ExecutionSessionState;
	readonly parentExecutionProfile: ExecutionProfile;
};

function resolveExecutionPolicy(
	definition: AgentDefinition,
	parentExecutionState: ExecutionSessionState,
): Effect.Effect<ExecutionPolicy, AgentError> {
	if (definition.tools === undefined) {
		return Effect.succeed(parentExecutionState.policy);
	}

	if (definition.tools.length === 0) {
		return Effect.fail(
			new AgentError({
				message: `Agent "${definition.name}" has an empty tool allowlist`,
			}),
		);
	}

	const tools = [...definition.tools];
	const [firstTool, ...restTools] = tools;
	if (firstTool === undefined) {
		return Effect.fail(
			new AgentError({
				message: `Agent "${definition.name}" has an empty tool allowlist`,
			}),
		);
	}

	return Effect.succeed({
		tools: {
			kind: "allowlist",
			tools: [firstTool, ...restTools],
		},
	});
}

function resolveConcreteModelSpec(
	definition: AgentDefinition,
	spec: ModelSpec,
	index: number,
	parentExecutionProfile: ExecutionProfile,
): Effect.Effect<{ readonly model: string; readonly thinking: PromptModeThinkingLevel }, AgentError> {
	const model =
		spec.model === "inherit"
			? parentExecutionProfile.promptProfile.model
			: spec.model;

	if (!isFullyQualifiedModelId(model)) {
		return Effect.fail(
			new AgentError({
				message:
					`Agent "${definition.name}" model at index ${index} resolved to invalid model id: ${model}. ` +
					"Expected provider/model-id.",
			}),
		);
	}

	const thinking =
		spec.thinking === undefined || spec.thinking === "inherit"
			? parentExecutionProfile.promptProfile.thinking
			: spec.thinking;

	if (!isPromptModeThinkingLevel(thinking)) {
		return Effect.fail(
			new AgentError({
				message:
					`Agent "${definition.name}" thinking at index ${index} resolved to invalid value: ${thinking}. ` +
					"Expected one of off|minimal|low|medium|high|xhigh.",
			}),
		);
	}

	return Effect.succeed({
		model,
		thinking,
	});
}

function resolveConcreteModelSpecs(
	definition: AgentDefinition,
	parentExecutionProfile: ExecutionProfile,
): Effect.Effect<readonly { readonly model: string; readonly thinking: PromptModeThinkingLevel }[], AgentError> {
	if (definition.models.length === 0) {
		return Effect.fail(
			new AgentError({
				message: `Agent "${definition.name}" has no models configured`,
			}),
		);
	}

	return Effect.forEach(definition.models, (spec, index) =>
		resolveConcreteModelSpec(
			definition,
			spec,
			index,
			parentExecutionProfile,
		),
	);
}

function withModelsByMode(
	state: ExecutionSessionState,
	overrides: Partial<ExecutionSessionState["modelsByMode"]> = {},
): ExecutionSessionState["modelsByMode"] | undefined {
	const base = state.modelsByMode;
	if (base === undefined && Object.keys(overrides).length === 0) {
		return undefined;
	}

	if (base === undefined) {
		return {
			...overrides,
		};
	}

	return {
		...base,
		...overrides,
	};
}

function resolveModeAgentExecution(
	mode: PromptModePresetName,
	input: ResolveAgentExecutionInput,
): Effect.Effect<ResolvedAgentExecution, AgentError> {
	return Effect.gen(function* () {
		const presets = yield* resolvePromptModePresets(input.cwd).pipe(
			Effect.mapError(
				(cause) =>
					new AgentError({
						message:
							cause instanceof Error
								? cause.message
								: `Could not load prompt mode presets for ${mode}`,
					}),
			),
		);

		const preset = presets[mode];
		const candidates = resolveModeModelCandidates(
			input.parentExecutionState,
			mode,
			preset.model,
		);
		const resolvedModel = candidates.find((candidate) => isFullyQualifiedModelId(candidate));
		if (resolvedModel === undefined) {
			return yield* Effect.fail(
				new AgentError({
					message: `Mode agent "${mode}" could not resolve a valid model id`,
				}),
			);
		}

		if (!isPromptModeThinkingLevel(preset.thinking)) {
			return yield* Effect.fail(
				new AgentError({
					message: `Mode agent "${mode}" resolved an invalid thinking level: ${preset.thinking}`,
				}),
			);
		}

		const executionPolicy = yield* resolveExecutionPolicy(
			input.definition,
			input.parentExecutionState,
		);

		const resolvedDefinition: AgentDefinition = {
			...input.definition,
			models: [{
				model: resolvedModel,
				thinking: preset.thinking,
			}],
		};

		const selector = { mode } as const;
		const executionProfile = makeExecutionProfile({
			selector,
			promptProfile: {
				mode,
				model: resolvedModel,
				thinking: preset.thinking,
			},
			policy: executionPolicy,
		});

		const modelsByMode = withModelsByMode(input.parentExecutionState, {
			[mode]: resolvedModel,
		});

		const executionState: ExecutionSessionState = {
			selector,
			policy: executionPolicy,
			...(modelsByMode === undefined ? {} : { modelsByMode }),
		};

		return {
			definition: resolvedDefinition,
			executionProfile,
			executionState,
		};
	});
}

function resolveDefaultAgentExecution(
	input: ResolveAgentExecutionInput,
): Effect.Effect<ResolvedAgentExecution, AgentError> {
	return Effect.gen(function* () {
		const resolvedModels = yield* resolveConcreteModelSpecs(
			input.definition,
			input.parentExecutionProfile,
		);
		const firstModel = resolvedModels[0];
		if (firstModel === undefined) {
			return yield* Effect.fail(
				new AgentError({
					message: `Agent "${input.definition.name}" has no concrete execution model`,
				}),
			);
		}

		const executionPolicy = yield* resolveExecutionPolicy(
			input.definition,
			input.parentExecutionState,
		);

		const resolvedDefinition: AgentDefinition = {
			...input.definition,
			models: resolvedModels,
		};

		const selector = {
			mode: "default",
		} as const;

		const executionProfile = makeExecutionProfile({
			selector,
			promptProfile: {
				mode: "default",
				model: firstModel.model,
				thinking: firstModel.thinking,
			},
			policy: executionPolicy,
		});

		const modelsByMode = withModelsByMode(input.parentExecutionState);
		const executionState: ExecutionSessionState = {
			selector,
			policy: executionPolicy,
			...(modelsByMode === undefined ? {} : { modelsByMode }),
		};

		return {
			definition: resolvedDefinition,
			executionProfile,
			executionState,
		};
	});
}

export function resolveAgentExecutionAtSpawn(
	input: ResolveAgentExecutionInput,
): Effect.Effect<ResolvedAgentExecution, AgentError> {
	if (isPromptModePresetName(input.definition.name)) {
		return resolveModeAgentExecution(input.definition.name, input);
	}

	return resolveDefaultAgentExecution(input);
}
