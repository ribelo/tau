import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { SandboxConfig } from "../sandbox/config.js";

export type AgentId = string;

export type Complexity = "low" | "medium" | "high";

export interface TaskType {
	readonly name: string;
	readonly description: string;
	/**
	 * Allowed tools for this task type.
	 * - undefined: allow all tools
	 */
	tools?: string[] | undefined;
	/**
	 * Default model to use.
	 * - undefined or "inherit": use parent model
	 */
	model?: string | undefined;
	defaultThinking?: ThinkingLevel | undefined;
	complexity?:
		| {
				readonly low?: { readonly model?: string; readonly thinking?: ThinkingLevel } | undefined;
				readonly medium?: { readonly model?: string; readonly thinking?: ThinkingLevel } | undefined;
				readonly high?: { readonly model?: string; readonly thinking?: ThinkingLevel } | undefined;
		  }
		| undefined;
	/** Default skills to inject */
	skills?: string[] | undefined;
	/** Optional sandbox/approval overrides for workers spawned under this task type. */
	sandbox?: SandboxConfig | undefined;
}

export interface ResolvedPolicy {
	readonly taskType: string;
	readonly complexity: Complexity;
	model?: string | undefined;
	thinking?: ThinkingLevel | undefined;
	tools?: string[] | undefined;
	readonly skills: string[];
	sandbox?: SandboxConfig | undefined;
}
