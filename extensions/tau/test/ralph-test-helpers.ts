import { Effect, Layer } from "effect";

import {
	type ExecutionProfile,
	DEFAULT_EXECUTION_POLICY,
	makeExecutionProfile as makeCanonicalExecutionProfile,
} from "../src/execution/schema.js";
import type { PromptModeProfile } from "../src/prompt/profile.js";
import { DEFAULT_SANDBOX_CONFIG, type ResolvedSandboxConfig } from "../src/sandbox/config.js";
import { PromptModes } from "../src/services/prompt-modes.js";

export function makePromptProfile(overrides?: Partial<PromptModeProfile>): PromptModeProfile {
	return {
		mode: "smart",
		model: "anthropic/claude-opus-4-5",
		thinking: "medium",
		...overrides,
	};
}

export function makePromptModesStubLayer(profile: PromptModeProfile = makePromptProfile()) {
	const executionProfile = makeExecutionProfileForPrompt(profile);

	return Layer.succeed(
		PromptModes,
		PromptModes.of({
			setup: Effect.void,
			captureCurrentProfile: () => Effect.succeed(profile),
			captureCurrentExecutionProfile: () => Effect.succeed(executionProfile),
			applyProfile: (nextProfile) =>
				Effect.succeed({
					applied: true as const,
					profile: nextProfile,
				}),
			applyExecutionProfile: (nextProfile: ExecutionProfile) =>
				Effect.succeed({
					applied: true as const,
					profile: nextProfile.promptProfile,
				}),
		}),
	);
}

export function makeExecutionProfileForPrompt(promptProfile: PromptModeProfile): ExecutionProfile {
	return makeCanonicalExecutionProfile({
		selector: {
			mode: promptProfile.mode,
		},
		promptProfile,
		policy: DEFAULT_EXECUTION_POLICY,
	});
}

export function makeExecutionProfile(overrides?: Partial<PromptModeProfile>): ExecutionProfile {
	return makeExecutionProfileForPrompt(makePromptProfile(overrides));
}

export function makeSandboxProfile(): ResolvedSandboxConfig {
	return DEFAULT_SANDBOX_CONFIG;
}
