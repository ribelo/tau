import { Effect, Schema } from "effect";

import type { DreamConfigError } from "./errors.js";

export const DreamThinking = Schema.Literals(["low", "medium", "high", "xhigh"]);
export type DreamThinking = typeof DreamThinking.Type;

export const DreamModelConfigInput = Schema.Struct({
	model: Schema.optional(Schema.String),
	thinking: Schema.optional(DreamThinking),
	maxTurns: Schema.optional(Schema.Number),
});
export type DreamModelConfigInput = typeof DreamModelConfigInput.Type;

export const ManualDreamConfigInput = Schema.Struct({
	enabled: Schema.optional(Schema.Boolean),
});
export type ManualDreamConfigInput = typeof ManualDreamConfigInput.Type;

export const AutoDreamConfigInput = Schema.Struct({
	enabled: Schema.optional(Schema.Boolean),
	minHoursSinceLastRun: Schema.optional(Schema.Number),
	minSessionsSinceLastRun: Schema.optional(Schema.Number),
	scanThrottleMinutes: Schema.optional(Schema.Number),
});
export type AutoDreamConfigInput = typeof AutoDreamConfigInput.Type;

export const DreamConfigInput = Schema.Struct({
	enabled: Schema.optional(Schema.Boolean),
	manual: Schema.optional(ManualDreamConfigInput),
	auto: Schema.optional(AutoDreamConfigInput),
	subagent: Schema.optional(DreamModelConfigInput),
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
