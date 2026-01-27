import { Layer, ManagedRuntime } from "effect";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { AgentControl, AgentConfig } from "./services.js";
import { AgentControlLive } from "./control.js";
import { AgentManagerLive } from "./manager.js";
import { PiAPILive } from "../effect/pi.js";
import { SandboxLive } from "../services/sandbox.js";
import { SandboxStateLive } from "../services/state.js";
import { PersistenceLive } from "../services/persistence.js";
import { PiLoggerLive } from "../effect/logger.js";
import { createAgentToolDef, type AgentToolContext, type AgentToolDef } from "./tool.js";

// Module-level runtime - initialized once, shared across all tool calls and workers
let sharedRuntime: ManagedRuntime.ManagedRuntime<AgentControl, never> | null = null;

/**
 * Initialize the shared agent runtime.
 * Must be called once at extension startup.
 */
export function initAgentRuntime(pi: ExtensionAPI): void {
	if (sharedRuntime) {
		return; // Already initialized
	}

	const AgentConfigLive = Layer.succeed(AgentConfig, AgentConfig.of({
		maxThreads: 12,
		maxDepth: 3,
	}));

	const MainLayer = AgentControlLive.pipe(
		Layer.provide(AgentManagerLive),
		Layer.provide(AgentConfigLive),
		Layer.provide(SandboxLive),
		Layer.provide(SandboxStateLive),
		Layer.provide(PersistenceLive),
		Layer.provide(PiLoggerLive),
		Layer.provide(PiAPILive(pi)),
	);

	sharedRuntime = ManagedRuntime.make(MainLayer);
}

/**
 * Get the shared runtime for agent operations.
 * Must be called after initAgentRuntime().
 */
export function getAgentRuntime(): ManagedRuntime.ManagedRuntime<AgentControl, never> {
	if (!sharedRuntime) {
		throw new Error("Agent runtime not initialized. Call initAgentRuntime() first.");
	}
	return sharedRuntime;
}

/**
 * Create an agent tool for use in worker sessions.
 * Uses the shared runtime so all agents use the same manager.
 */
export function createWorkerAgentTool(context: AgentToolContext): AgentToolDef {
	const runtime = getAgentRuntime();
	return createAgentToolDef(
		(effect) => runtime.runPromise(effect),
		() => context,
	);
}
