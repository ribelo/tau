import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

import { readJsonFile } from "../shared/fs.js";
import { isRecord } from "../shared/json.js";
import { findNearestProjectPiDir, getUserSettingsPath } from "../shared/discovery.js";

export type PromptModeName = "smart" | "deep" | "rush";

type PromptModePreset = {
	readonly model: string;
	readonly thinking: ThinkingLevel;
	readonly systemPrompt: string;
};

const MODE_PROMPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "modes");

const loadModePrompt = (filename: "smart.md" | "deep.md" | "rush.md"): string => {
	const filePath = path.join(MODE_PROMPTS_DIR, filename);
	return fs.readFileSync(filePath, "utf-8").trim();
};

const DEFAULT_PROMPT_MODE_CONFIG: Record<
	PromptModeName,
	{ readonly model: string; readonly thinking: ThinkingLevel; readonly promptFile: "smart.md" | "deep.md" | "rush.md" }
> = {
	smart: { model: "anthropic/claude-opus-4-5", thinking: "medium", promptFile: "smart.md" },
	deep: { model: "openai-codex/gpt-5.3-codex", thinking: "high", promptFile: "deep.md" },
	rush: { model: "kimi-coding/kimi-k2-thinking", thinking: "off", promptFile: "rush.md" },
};

let cachedDefaultPromptModePresets: Record<PromptModeName, PromptModePreset> | undefined;

function getDefaultPromptModePresets(): Record<PromptModeName, PromptModePreset> {
	if (cachedDefaultPromptModePresets) {
		return cachedDefaultPromptModePresets;
	}

	cachedDefaultPromptModePresets = {
		smart: {
			model: DEFAULT_PROMPT_MODE_CONFIG.smart.model,
			thinking: DEFAULT_PROMPT_MODE_CONFIG.smart.thinking,
			systemPrompt: loadModePrompt(DEFAULT_PROMPT_MODE_CONFIG.smart.promptFile),
		},
		deep: {
			model: DEFAULT_PROMPT_MODE_CONFIG.deep.model,
			thinking: DEFAULT_PROMPT_MODE_CONFIG.deep.thinking,
			systemPrompt: loadModePrompt(DEFAULT_PROMPT_MODE_CONFIG.deep.promptFile),
		},
		rush: {
			model: DEFAULT_PROMPT_MODE_CONFIG.rush.model,
			thinking: DEFAULT_PROMPT_MODE_CONFIG.rush.thinking,
			systemPrompt: loadModePrompt(DEFAULT_PROMPT_MODE_CONFIG.rush.promptFile),
		},
	};

	return cachedDefaultPromptModePresets;
}

export const isPromptModeName = (value: string): value is PromptModeName =>
	value === "smart" || value === "deep" || value === "rush";

type PromptModePresetOverride = {
	readonly model?: string;
	readonly thinking?: ThinkingLevel;
};

const THINKING_LEVELS: ReadonlySet<string> = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
]);

function assertFullyQualifiedModelIdOrThrow(value: string, context: string): void {
	const idx = value.indexOf("/");
	if (idx <= 0 || idx >= value.length - 1) {
		throw new Error(`${context}: model must be "provider/model-id"`);
	}
}

function parsePresetOverride(value: unknown, context: string): PromptModePresetOverride | null {
	if (value === undefined) return null;
	if (!isRecord(value)) {
		throw new Error(`${context}: must be an object`);
	}

	const modelRaw = value["model"];
	const thinkingRaw = value["thinking"];

	const override: { model?: string; thinking?: ThinkingLevel } = {};

	if (modelRaw !== undefined) {
		if (typeof modelRaw !== "string") {
			throw new Error(`${context}.model: must be a string`);
		}
		assertFullyQualifiedModelIdOrThrow(modelRaw, `${context}.model`);
		override.model = modelRaw;
	}

	if (thinkingRaw !== undefined) {
		if (typeof thinkingRaw !== "string") {
			throw new Error(`${context}.thinking: must be a string`);
		}
		if (!THINKING_LEVELS.has(thinkingRaw)) {
			throw new Error(
				`${context}.thinking: must be one of off, minimal, low, medium, high, xhigh`,
			);
		}
		override.thinking = thinkingRaw as ThinkingLevel;
	}

	if (override.model === undefined && override.thinking === undefined) {
		return null;
	}

	return override;
}

function findNearestProjectSettingsPath(cwd: string): string | null {
	const piDir = findNearestProjectPiDir(cwd);
	if (!piDir) return null;
	const candidate = path.join(piDir, "settings.json");
	return readJsonFile(candidate) ? candidate : null;
}

function readPromptModesNamespace(settings: unknown): unknown {
	if (!isRecord(settings)) return undefined;

	const tau = settings["tau"];
	const tauPromptModes = isRecord(tau) ? tau["promptModes"] : undefined;
	if (tauPromptModes !== undefined) return tauPromptModes;

	const legacy = settings["promptModes"];
	return legacy;
}

function readPromptModeOverridesFromSettingsFile(
	filePath: string,
): Partial<Record<PromptModeName, PromptModePresetOverride>> {
	const json = readJsonFile(filePath);
	if (!json) return {};

	const ns = readPromptModesNamespace(json);
	if (!isRecord(ns)) return {};

	const presets = ns["presets"];
	if (!isRecord(presets)) return {};

	const out: Partial<Record<PromptModeName, PromptModePresetOverride>> = {};
	for (const mode of ["smart", "deep", "rush"] as const) {
		const override = parsePresetOverride(
			presets[mode],
			`${filePath}: promptModes.presets.${mode}`,
		);
		if (override) out[mode] = override;
	}
	return out;
}

export function resolvePromptModePresets(cwd: string): Record<PromptModeName, PromptModePreset> {
	const defaults = getDefaultPromptModePresets();
	const globalPath = getUserSettingsPath();
	const projectPath = findNearestProjectSettingsPath(cwd);

	const globalOverrides = readPromptModeOverridesFromSettingsFile(globalPath);
	const projectOverrides = projectPath
		? readPromptModeOverridesFromSettingsFile(projectPath)
		: {};

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
}
