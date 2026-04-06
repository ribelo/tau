import { Effect, Layer } from "effect";

import type { PromptModeProfile } from "../src/prompt/profile.js";
import { PromptModes } from "../src/services/prompt-modes.js";

export function makePromptProfile(
	overrides?: Partial<PromptModeProfile>,
): PromptModeProfile {
	return {
		mode: "smart",
		model: "anthropic/claude-opus-4-5",
		thinking: "medium",
		...overrides,
	};
}

export function makePromptModesStubLayer(profile: PromptModeProfile = makePromptProfile()) {
	return Layer.succeed(
		PromptModes,
		PromptModes.of({
			setup: Effect.void,
			captureCurrentProfile: () => Effect.succeed(profile),
			applyProfile: (nextProfile) =>
				Effect.succeed({
					applied: true as const,
					profile: nextProfile,
				}),
		}),
	);
}
