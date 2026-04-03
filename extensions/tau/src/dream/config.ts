import { Effect, Schema } from "effect";

import type { DreamConfigError } from "./errors.js";

export const DreamThinking = Schema.Literals(["low", "medium", "high", "xhigh"]);
export type DreamThinking = typeof DreamThinking.Type;

export const DreamModelConfigInput = Schema.Struct({
	model: Schema.String,
	thinking: DreamThinking,
	maxTurns: Schema.Number,
});
export type DreamModelConfigInput = typeof DreamModelConfigInput.Type;

export const ManualDreamConfigInput = Schema.Struct({
	enabled: Schema.Boolean,
});
export type ManualDreamConfigInput = typeof ManualDreamConfigInput.Type;

export const AutoDreamConfigInput = Schema.Struct({
	enabled: Schema.Boolean,
	minHoursSinceLastRun: Schema.Number,
	minSessionsSinceLastRun: Schema.Number,
	scanThrottleMinutes: Schema.Number,
});
export type AutoDreamConfigInput = typeof AutoDreamConfigInput.Type;

export const DreamConfigInput = Schema.Struct({
	enabled: Schema.Boolean,
	manual: ManualDreamConfigInput,
	auto: AutoDreamConfigInput,
	subagent: DreamModelConfigInput,
});
export type DreamConfigInput = typeof DreamConfigInput.Type;

export const TauSettingsWithDreamInput = Schema.Struct({
	tau: Schema.Struct({
		dream: Schema.optional(DreamConfigInput),
	}),
});
export type TauSettingsWithDreamInput = typeof TauSettingsWithDreamInput.Type;

export interface DreamModelConfig {
	readonly model: string;
	readonly thinking: DreamThinking;
	readonly maxTurns: number;
}

export interface AutoDreamConfig {
	readonly enabled: boolean;
	readonly minHoursSinceLastRun: number;
	readonly minSessionsSinceLastRun: number;
	readonly scanThrottleMinutes: number;
}

export interface DreamConfig {
	readonly enabled: boolean;
	readonly manual: {
		readonly enabled: boolean;
	};
	readonly auto: AutoDreamConfig;
	readonly subagent: DreamModelConfig;
}

export interface DreamConfigLoader {
	readonly load: (settingsJson: unknown) => Effect.Effect<DreamConfig, DreamConfigError>;
}
