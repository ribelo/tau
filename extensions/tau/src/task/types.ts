import type { ThinkingLevel } from "@mariozechner/pi-ai";
import type { SandboxConfig } from "../sandbox/config.js";

export type Complexity = "low" | "medium" | "high";

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
	model?: string;
	defaultThinking?: ThinkingLevel;
	complexity?: {
		low?: { model?: string; thinking?: ThinkingLevel };
		medium?: { model?: string; thinking?: ThinkingLevel };
		high?: { model?: string; thinking?: ThinkingLevel };
	};
	/** Default skills to inject */
	skills?: string[];
	/** Optional sandbox/approval overrides for workers spawned under this task type. */
	sandbox?: SandboxConfig;
}

export interface ResolvedPolicy {
	taskType: string;
	complexity: Complexity;
	model?: string;
	thinking?: ThinkingLevel;
	tools?: string[];
	skills: string[];
	sandbox?: SandboxConfig;
}
