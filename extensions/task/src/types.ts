import type { ThinkingLevel } from "@mariozechner/pi-ai";

export type Difficulty = "small" | "medium" | "large";

export interface TaskType {
	name: string;
	description: string;
	/**
	 * Allowed tools for this task type.
	 * - undefined: allow all tools
	 */
	tools?: string[];
	/**
	 * Default model to use.
	 * - undefined or "inherit": use parent model
	 */
	defaultModel?: string;
	defaultThinking?: ThinkingLevel;
	difficulty?: {
		small?: { model?: string; thinking?: ThinkingLevel };
		medium?: { model?: string; thinking?: ThinkingLevel };
		large?: { model?: string; thinking?: ThinkingLevel };
	};
	/** Default skills to inject */
	skills?: string[];
}

export interface ResolvedPolicy {
	taskType: string;
	difficulty: Difficulty;
	model?: string;
	thinking?: ThinkingLevel;
	tools?: string[];
	skills: string[];
}
