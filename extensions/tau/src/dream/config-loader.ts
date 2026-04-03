import { Effect, Schema } from "effect";

import type { AnyRecord } from "../shared/json.js";
import { deepMerge, isRecord } from "../shared/json.js";
import { readProjectSettings, readUserSettings, type SettingsError } from "../shared/settings.js";
import type { DreamConfig } from "./config.js";
import { DreamConfigInput } from "./config.js";
import {
	DreamConfigDecodeError,
	DreamConfigInvalidThreshold,
	type DreamConfigError,
} from "./errors.js";

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

		const minHoursSinceLastRun = yield* validateThreshold(
			"auto.minHoursSinceLastRun",
			decoded.auto.minHoursSinceLastRun,
		);
		const minSessionsSinceLastRun = yield* validateThreshold(
			"auto.minSessionsSinceLastRun",
			decoded.auto.minSessionsSinceLastRun,
		);
		const scanThrottleMinutes = yield* validateThreshold(
			"auto.scanThrottleMinutes",
			decoded.auto.scanThrottleMinutes,
		);

		const maxTurns = yield* validatePositiveInteger(
			"subagent.maxTurns",
			decoded.subagent.maxTurns,
		);

		return {
			enabled: decoded.enabled,
			manual: {
				enabled: decoded.manual.enabled,
			},
			auto: {
				enabled: decoded.auto.enabled,
				minHoursSinceLastRun,
				minSessionsSinceLastRun,
				scanThrottleMinutes,
			},
			subagent: {
				model: decoded.subagent.model,
				thinking: decoded.subagent.thinking,
				maxTurns,
			},
		} satisfies DreamConfig;
	});
}
