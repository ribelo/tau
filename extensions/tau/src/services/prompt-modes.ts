import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Effect, Layer, ServiceMap } from "effect";

import type { ExecutionProfile } from "../execution/schema.js";
import type { PromptModeProfile } from "../prompt/profile.js";
import {
	ExecutionRuntime,
	type PromptModeApplyOptions,
	type PromptModeApplyResult,
} from "./execution-runtime.js";

export type { PromptModeApplyResult } from "./execution-runtime.js";

export interface PromptModes {
	readonly setup: Effect.Effect<void>;
	readonly captureCurrentProfile: (
		ctx: Pick<ExtensionContext, "model">,
	) => Effect.Effect<PromptModeProfile | null>;
	readonly captureCurrentExecutionProfile: (
		ctx: Pick<ExtensionContext, "model">,
	) => Effect.Effect<ExecutionProfile | null>;
	readonly applyProfile: (
		profile: PromptModeProfile,
		ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "ui">,
		options?: PromptModeApplyOptions,
	) => Effect.Effect<PromptModeApplyResult>;
	readonly applyExecutionProfile: (
		profile: ExecutionProfile,
		ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "ui">,
		options?: PromptModeApplyOptions,
	) => Effect.Effect<PromptModeApplyResult>;
}

export const PromptModes = ServiceMap.Service<PromptModes>("PromptModes");

export const PromptModesLive = Layer.effect(
	PromptModes,
	Effect.gen(function* () {
		const executionRuntime = yield* ExecutionRuntime;
		return PromptModes.of({
			setup: executionRuntime.setup,
			captureCurrentProfile: executionRuntime.captureCurrentProfile,
			captureCurrentExecutionProfile: executionRuntime.captureCurrentExecutionProfile,
			applyProfile: executionRuntime.applyProfile,
			applyExecutionProfile: executionRuntime.applyExecutionProfile,
		});
	}),
);
