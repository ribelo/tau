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

function missingDreamFieldPaths(dream: AnyRecord): ReadonlyArray<string> {
	const missing: Array<string> = [];

	if (dream["enabled"] === undefined) {
		missing.push("tau.dream.enabled");
	}

	const manual = dream["manual"];
	if (!isRecord(manual) || manual["enabled"] === undefined) {
		missing.push("tau.dream.manual.enabled");
	}

	const auto = dream["auto"];
	if (!isRecord(auto)) {
		missing.push(
			"tau.dream.auto.enabled",
			"tau.dream.auto.minHoursSinceLastRun",
			"tau.dream.auto.minSessionsSinceLastRun",
			"tau.dream.auto.scanThrottleMinutes",
		);
	} else {
		if (auto["enabled"] === undefined) {
			missing.push("tau.dream.auto.enabled");
		}
		if (auto["minHoursSinceLastRun"] === undefined) {
			missing.push("tau.dream.auto.minHoursSinceLastRun");
		}
		if (auto["minSessionsSinceLastRun"] === undefined) {
			missing.push("tau.dream.auto.minSessionsSinceLastRun");
		}
		if (auto["scanThrottleMinutes"] === undefined) {
			missing.push("tau.dream.auto.scanThrottleMinutes");
		}
	}

	const subagent = dream["subagent"];
	if (!isRecord(subagent)) {
		missing.push(
			"tau.dream.subagent.model",
			"tau.dream.subagent.thinking",
			"tau.dream.subagent.maxTurns",
		);
	} else {
		if (subagent["model"] === undefined) {
			missing.push("tau.dream.subagent.model");
		}
		if (subagent["thinking"] === undefined) {
			missing.push("tau.dream.subagent.thinking");
		}
		if (subagent["maxTurns"] === undefined) {
			missing.push("tau.dream.subagent.maxTurns");
		}
	}

	return missing;
}

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
		const missingFields = missingDreamFieldPaths(mergedDreamSettings);
		if (missingFields.length > 0) {
			return yield* new DreamConfigDecodeError({
				reason: `Missing required dream config fields: ${missingFields.join(", ")}`,
			});
		}

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
