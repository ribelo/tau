import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

export type PromptModeName = "smart" | "deep" | "rush";

export type PromptModePreset = {
	readonly model: string;
	readonly thinking: ThinkingLevel;
	readonly systemPrompt: string;
};

const MODE_PROMPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "modes");

const loadModePrompt = (filename: "smart.md" | "deep.md" | "rush.md"): string =>
	readFileSync(path.join(MODE_PROMPTS_DIR, filename), "utf8").trim();

export const SMART_MODE_SYSTEM_PROMPT = loadModePrompt("smart.md");
export const DEEP_MODE_SYSTEM_PROMPT = loadModePrompt("deep.md");
export const RUSH_MODE_SYSTEM_PROMPT = loadModePrompt("rush.md");

// NOTE: Erg uses its own thinking variant IDs (e.g. "on", "high", "off").
// pi uses ThinkingLevel ("off" | "minimal" | "low" | "medium" | "high" | "xhigh").
// This mapping keeps the intent while staying within pi's supported levels.
export const DEFAULT_PROMPT_MODE_PRESETS: Record<PromptModeName, PromptModePreset> = {
	smart: {
		model: "anthropic/claude-opus-4-5",
		thinking: "medium",
		systemPrompt: SMART_MODE_SYSTEM_PROMPT,
	},
	deep: {
		model: "openai-codex/gpt-5.3-codex",
		thinking: "high",
		systemPrompt: DEEP_MODE_SYSTEM_PROMPT,
	},
	rush: {
		model: "kimi-coding/kimi-k2-thinking",
		thinking: "off",
		systemPrompt: RUSH_MODE_SYSTEM_PROMPT,
	},
};

export const isPromptModeName = (value: string): value is PromptModeName =>
	value === "smart" || value === "deep" || value === "rush";
