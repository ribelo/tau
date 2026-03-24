import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { Data, Effect } from "effect";

import { isRecord } from "../shared/json.js";
import { readProjectSettings, readUserSettings, type SettingsError } from "../shared/settings.js";
import {
	isPromptModeThinkingLevel,
	validatePromptModeModelId,
	type PromptModeThinkingLevel,
} from "../agent/model-spec.js";

export type PromptModeName = "smart" | "deep" | "rush";

type PromptModePreset = {
	readonly model: string;
	readonly thinking: ThinkingLevel;
	readonly systemPrompt: string;
};

export class PromptModeConfigError extends Data.TaggedError("PromptModeConfigError")<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

const MODE_PROMPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "modes");

const loadModePrompt = (
	filename: "smart.md" | "deep.md" | "rush.md",
): Effect.Effect<string, PromptModeConfigError> => {
	const filePath = path.join(MODE_PROMPTS_DIR, filename);
	return Effect.tryPromise({
		try: () => fs.readFile(filePath, "utf-8"),
		catch: (cause) =>
			new PromptModeConfigError({
				message: `Failed to read prompt mode file ${filePath}`,
				cause,
			}),
	}).pipe(Effect.map((content) => content.trim()));
};

const DEFAULT_PROMPT_MODE_CONFIG: Record<
	PromptModeName,
	{ readonly model: string; readonly thinking: ThinkingLevel; readonly promptFile: "smart.md" | "deep.md" | "rush.md" }
> = {
	smart: { model: "anthropic/claude-opus-4-5", thinking: "medium", promptFile: "smart.md" },
	deep: { model: "openai-codex/gpt-5.3-codex", thinking: "high", promptFile: "deep.md" },
	rush: { model: "kimi-coding/kimi-k2-thinking", thinking: "off", promptFile: "rush.md" },
};

let cachedDefaultPromptModePresets:
	| Promise<Record<PromptModeName, PromptModePreset>>
	| undefined;

function getDefaultPromptModePresets(): Effect.Effect<
	Record<PromptModeName, PromptModePreset>,
	PromptModeConfigError
> {
	if (!cachedDefaultPromptModePresets) {
		cachedDefaultPromptModePresets = Effect.runPromise(
			Effect.all({
				smart: loadModePrompt(DEFAULT_PROMPT_MODE_CONFIG.smart.promptFile).pipe(
					Effect.map((systemPrompt) => ({
						model: DEFAULT_PROMPT_MODE_CONFIG.smart.model,
						thinking: DEFAULT_PROMPT_MODE_CONFIG.smart.thinking,
						systemPrompt,
					})),
				),
				deep: loadModePrompt(DEFAULT_PROMPT_MODE_CONFIG.deep.promptFile).pipe(
					Effect.map((systemPrompt) => ({
						model: DEFAULT_PROMPT_MODE_CONFIG.deep.model,
						thinking: DEFAULT_PROMPT_MODE_CONFIG.deep.thinking,
						systemPrompt,
					})),
				),
				rush: loadModePrompt(DEFAULT_PROMPT_MODE_CONFIG.rush.promptFile).pipe(
					Effect.map((systemPrompt) => ({
						model: DEFAULT_PROMPT_MODE_CONFIG.rush.model,
						thinking: DEFAULT_PROMPT_MODE_CONFIG.rush.thinking,
						systemPrompt,
					})),
				),
			}),
		);
	}

	return Effect.tryPromise({
		try: () => cachedDefaultPromptModePresets as Promise<Record<PromptModeName, PromptModePreset>>,
		catch: (cause) =>
			new PromptModeConfigError({
				message: "Failed to resolve default prompt mode presets",
				cause,
			}),
	});
}

export const isPromptModeName = (value: string): value is PromptModeName =>
	value === "smart" || value === "deep" || value === "rush";

type PromptModePresetOverride = {
	readonly model?: string;
	readonly thinking?: ThinkingLevel;
};

function parsePresetOverride(
	value: unknown,
	context: string,
): Effect.Effect<PromptModePresetOverride | null, PromptModeConfigError> {
	if (value === undefined) return Effect.succeed(null);
	if (!isRecord(value)) {
		return Effect.fail(new PromptModeConfigError({ message: `${context}: must be an object` }));
	}

	const modelRaw = value["model"];
	const thinkingRaw = value["thinking"];
	const override: { model?: string; thinking?: ThinkingLevel } = {};

	const validateModel =
		modelRaw === undefined
			? Effect.void
			: typeof modelRaw !== "string"
				? Effect.fail(
						new PromptModeConfigError({ message: `${context}.model: must be a string` }),
					)
				: validatePromptModeModelId(modelRaw, `${context}.model`).pipe(
						Effect.mapError(
							(error) =>
								new PromptModeConfigError({
									message: error.message,
									cause: error,
								}),
						),
						Effect.tap((model) =>
							Effect.sync(() => {
								override.model = model;
							}),
						),
					);

	const validateThinking =
		thinkingRaw === undefined
			? Effect.void
			: typeof thinkingRaw !== "string"
				? Effect.fail(
						new PromptModeConfigError({
							message: `${context}.thinking: must be a string`,
						}),
					)
				: isPromptModeThinkingLevel(thinkingRaw)
					? Effect.sync(() => {
							override.thinking = thinkingRaw as PromptModeThinkingLevel;
						})
					: Effect.fail(
							new PromptModeConfigError({
								message: `${context}.thinking: must be one of off, minimal, low, medium, high, xhigh`,
							}),
						);

	return Effect.gen(function* () {
		yield* validateModel;
		yield* validateThinking;
		return override.model === undefined && override.thinking === undefined ? null : override;
	});
}

function readPromptModesNamespace(settings: unknown): unknown {
	if (!isRecord(settings)) return undefined;

	const tau = settings["tau"];
	const tauPromptModes = isRecord(tau) ? tau["promptModes"] : undefined;
	if (tauPromptModes !== undefined) return tauPromptModes;

	const legacy = settings["promptModes"];
	return legacy;
}

function readPromptModeOverridesFromSettings(
	settings: unknown,
	context: string,
): Effect.Effect<Partial<Record<PromptModeName, PromptModePresetOverride>>, PromptModeConfigError> {
	const ns = readPromptModesNamespace(settings);
	if (!isRecord(ns)) return Effect.succeed({});

	const presets = ns["presets"];
	if (!isRecord(presets)) return Effect.succeed({});

	return Effect.all({
		smart: parsePresetOverride(presets["smart"], `${context}: promptModes.presets.smart`),
		deep: parsePresetOverride(presets["deep"], `${context}: promptModes.presets.deep`),
		rush: parsePresetOverride(presets["rush"], `${context}: promptModes.presets.rush`),
	}).pipe(
		Effect.map((overrides) => {
			const out: Partial<Record<PromptModeName, PromptModePresetOverride>> = {};
			if (overrides.smart) out.smart = overrides.smart;
			if (overrides.deep) out.deep = overrides.deep;
			if (overrides.rush) out.rush = overrides.rush;
			return out;
		}),
	);
}

export function resolvePromptModePresets(
	cwd: string,
): Effect.Effect<Record<PromptModeName, PromptModePreset>, PromptModeConfigError | SettingsError> {
	return Effect.all({
		defaults: getDefaultPromptModePresets(),
		globalSettings: readUserSettings(),
		projectSettings: readProjectSettings(cwd),
	}).pipe(
		Effect.flatMap(({ defaults, globalSettings, projectSettings }) =>
			Effect.all({
				globalOverrides:
					globalSettings === null
						? Effect.succeed({} as Partial<Record<PromptModeName, PromptModePresetOverride>>)
						: readPromptModeOverridesFromSettings(globalSettings, "user settings"),
				projectOverrides:
					projectSettings === null
						? Effect.succeed({} as Partial<Record<PromptModeName, PromptModePresetOverride>>)
						: readPromptModeOverridesFromSettings(projectSettings, "project settings"),
			}).pipe(
				Effect.map(({ globalOverrides, projectOverrides }) => {
					const resolved: Record<PromptModeName, PromptModePreset> = {
						smart: { ...defaults.smart },
						deep: { ...defaults.deep },
						rush: { ...defaults.rush },
					};

					for (const mode of ["smart", "deep", "rush"] as const) {
						const override = {
							...globalOverrides[mode],
							...projectOverrides[mode],
						};
						if (override.model !== undefined) {
							resolved[mode] = { ...resolved[mode], model: override.model };
						}
						if (override.thinking !== undefined) {
							resolved[mode] = { ...resolved[mode], thinking: override.thinking };
						}
					}

					return resolved;
				}),
			),
		),
	);
}
