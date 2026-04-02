import { Effect, Schema } from "effect";

import type { AnyRecord } from "../shared/json.js";
import { deepMerge, isRecord } from "../shared/json.js";
import { readProjectSettings, readUserSettings, type SettingsError } from "../shared/settings.js";
import type { DreamConfig, DreamThinking } from "./config.js";
import { DreamConfigInput } from "./config.js";
import {
	DreamConfigDecodeError,
	DreamConfigInvalidThreshold,
	DreamConfigMissingModel,
	type DreamConfigError,
} from "./errors.js";

const DEFAULT_ENABLED = true;
const DEFAULT_MANUAL_ENABLED = true;
const DEFAULT_AUTO_ENABLED = false;
const DEFAULT_MIN_HOURS_SINCE_LAST_RUN = 24;
const DEFAULT_MIN_SESSIONS_SINCE_LAST_RUN = 5;
const DEFAULT_SCAN_THROTTLE_MINUTES = 10;
const DEFAULT_THINKING: DreamThinking = "high";
const DEFAULT_MAX_TURNS = 8;

type PlanPreset = {
	readonly model?: string;
	readonly thinking?: DreamThinking;
};

const decodeDreamConfigInput = Schema.decodeUnknownEffect(DreamConfigInput);

function readDreamNamespace(settings: unknown): AnyRecord {
	if (!isRecord(settings)) {
		return {};
	}

	const tau = settings["tau"];
	if (!isRecord(tau)) {
		return {};
	}

	const dream = tau["dream"];
	return isRecord(dream) ? dream : {};
}

function isDreamThinking(value: unknown): value is DreamThinking {
	return value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function readPlanPreset(settings: unknown): PlanPreset {
	if (!isRecord(settings)) {
		return {};
	}

	const tau = settings["tau"];
	const promptModesRoot = isRecord(tau) && isRecord(tau["promptModes"])
		? tau["promptModes"]
		: settings["promptModes"];

	if (!isRecord(promptModesRoot)) {
		return {};
	}

	const presets = promptModesRoot["presets"];
	if (!isRecord(presets)) {
		return {};
	}

	const plan = presets["plan"];
	if (!isRecord(plan)) {
		return {};
	}

	const preset: {
		model?: string;
		thinking?: DreamThinking;
	} = {};

	if (typeof plan["model"] === "string") {
		preset.model = plan["model"];
	}

	if (isDreamThinking(plan["thinking"])) {
		preset.thinking = plan["thinking"];
	}

	return preset;
}

function mapSettingsError(error: SettingsError): DreamConfigError {
	return new DreamConfigDecodeError({ reason: error.message });
}

function validateThreshold(field: string, value: number): Effect.Effect<number, DreamConfigError> {
	if (value < 0) {
		return Effect.fail(new DreamConfigInvalidThreshold({ field, value }));
	}

	return Effect.succeed(value);
}

function validatePositiveInteger(field: string, value: number): Effect.Effect<number, DreamConfigError> {
	if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
		return Effect.fail(new DreamConfigInvalidThreshold({ field, value }));
	}

	return Effect.succeed(value);
}

function mergeDreamSettings(
	userSettings: AnyRecord | null,
	projectSettings: AnyRecord | null,
): AnyRecord {
	const userDream = readDreamNamespace(userSettings);
	const projectDream = readDreamNamespace(projectSettings);
	return deepMerge(userDream, projectDream);
}

function resolvePlanPreset(
	userSettings: AnyRecord | null,
	projectSettings: AnyRecord | null,
): PlanPreset {
	return {
		...readPlanPreset(userSettings),
		...readPlanPreset(projectSettings),
	};
}

export function loadDreamConfig(cwd: string): Effect.Effect<DreamConfig, DreamConfigError> {
	return Effect.gen(function* () {
		const userSettings = yield* readUserSettings().pipe(Effect.mapError(mapSettingsError));
		const projectSettings = yield* readProjectSettings(cwd).pipe(
			Effect.mapError(mapSettingsError),
		);

		const mergedDreamSettings = mergeDreamSettings(userSettings, projectSettings);
		const decoded = yield* decodeDreamConfigInput(mergedDreamSettings).pipe(
			Effect.mapError(
				(error) => new DreamConfigDecodeError({ reason: String(error) }),
			),
		);

		const planPreset = resolvePlanPreset(userSettings, projectSettings);

		const enabled = decoded.enabled ?? DEFAULT_ENABLED;
		const manualEnabled = decoded.manual?.enabled ?? DEFAULT_MANUAL_ENABLED;
		const autoEnabled = decoded.auto?.enabled ?? DEFAULT_AUTO_ENABLED;

		const minHoursSinceLastRun = yield* validateThreshold(
			"auto.minHoursSinceLastRun",
			decoded.auto?.minHoursSinceLastRun ?? DEFAULT_MIN_HOURS_SINCE_LAST_RUN,
		);
		const minSessionsSinceLastRun = yield* validateThreshold(
			"auto.minSessionsSinceLastRun",
			decoded.auto?.minSessionsSinceLastRun ?? DEFAULT_MIN_SESSIONS_SINCE_LAST_RUN,
		);
		const scanThrottleMinutes = yield* validateThreshold(
			"auto.scanThrottleMinutes",
			decoded.auto?.scanThrottleMinutes ?? DEFAULT_SCAN_THROTTLE_MINUTES,
		);

		const model = decoded.subagent?.model ?? planPreset.model;
		if (model === undefined) {
			return yield* new DreamConfigMissingModel({
				path: "tau.dream.subagent.model",
			});
		}

		const thinking = decoded.subagent?.thinking ?? planPreset.thinking ?? DEFAULT_THINKING;
		const maxTurns = yield* validatePositiveInteger(
			"subagent.maxTurns",
			decoded.subagent?.maxTurns ?? DEFAULT_MAX_TURNS,
		);

		return {
			enabled,
			manual: {
				enabled: manualEnabled,
			},
			auto: {
				enabled: autoEnabled,
				minHoursSinceLastRun,
				minSessionsSinceLastRun,
				scanThrottleMinutes,
			},
			subagent: {
				model,
				thinking,
				maxTurns,
			},
		} satisfies DreamConfig;
	});
}
