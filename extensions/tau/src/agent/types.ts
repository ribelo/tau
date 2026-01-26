import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { SandboxConfig } from "../sandbox/config.js";

export type AgentId = string;

export type Complexity = "low" | "medium" | "high";

export interface AgentDefinition {
	readonly name: string;
	readonly description: string;
	/**
	 * Default model to use.
	 * - undefined or "inherit": use parent model
	 */
	readonly model?: string | "inherit" | undefined;
	/**
	 * Thinking level for the agent.
	 * - undefined or "inherit": use parent thinking level
	 */
	readonly thinking?: ThinkingLevel | "inherit" | undefined;
	readonly sandbox: SandboxConfig;
	readonly systemPrompt: string;
}
