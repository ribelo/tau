import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { AgentRegistry } from "../agent/agent-registry.js";
import { buildToolDescription } from "../agent/tool.js";
import type { AgentToolHandle } from "../agent/index.js";
import { Effect } from "effect";

/**
 * Session-scoped agent enable/disable state.
 * All agents are enabled by default. State resets on session switch.
 */
const disabledAgents = new Set<string>();

export function isAgentDisabled(name: string): boolean {
	return disabledAgents.has(name);
}

export function setAgentEnabled(name: string, enabled: boolean): void {
	if (enabled) {
		disabledAgents.delete(name);
	} else {
		disabledAgents.add(name);
	}
}

function resetAgentStates(): void {
	disabledAgents.clear();
}

function loadRegistry(cwd: string): Effect.Effect<AgentRegistry, never> {
	return AgentRegistry.load(cwd).pipe(
		Effect.catch(() => Effect.die("Failed to load agent registry")),
	);
}

function refreshToolDescription(agentTool: AgentToolHandle, registry: AgentRegistry): void {
	const description = buildToolDescription(registry, undefined, isAgentDisabled);
	agentTool.refresh(description);
}

function formatStatusSummary(allNames: string[]): string {
	const disabled = allNames.filter((n) => isAgentDisabled(n));
	if (disabled.length === 0) return "All agents enabled";
	const enabled = allNames.filter((n) => !isAgentDisabled(n));
	return `Enabled: ${enabled.join(", ")}\nDisabled: ${disabled.join(", ")}`;
}

export default function initAgentsMenu(pi: ExtensionAPI, agentTool: AgentToolHandle): void {
	// Reset on session boundaries
	pi.on("session_start", async () => {
		resetAgentStates();
		const registry = await Effect.runPromise(loadRegistry(process.cwd()));
		refreshToolDescription(agentTool, registry);
	});
	pi.on("session_switch", async () => {
		resetAgentStates();
		const registry = await Effect.runPromise(loadRegistry(process.cwd()));
		refreshToolDescription(agentTool, registry);
	});

	pi.registerCommand("agents", {
		description: "Enable/disable agents for this session",
		getArgumentCompletions(prefix: string) {
			const words = prefix.trimStart().split(/\s+/);
			if (words.length <= 1) {
				const sub = words[0] ?? "";
				return ["list", "enable", "disable"]
					.filter((s) => s.startsWith(sub))
					.map((s) => ({ value: s, label: s }));
			}
			return null;
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;

			const registry = await Effect.runPromise(loadRegistry(ctx.cwd));
			const allNames = registry.names();

			const trimmed = (args || "").trim();

			if (trimmed) {
				const parts = trimmed.split(/\s+/);
				const action = parts[0]?.toLowerCase();
				const agentName = parts[1]?.toLowerCase();

				if (action === "list") {
					const lines = allNames.map((name: string) => {
						const enabled = !isAgentDisabled(name);
						const def = registry.get(name);
						const desc = def?.description.split("\n")[0]?.trim() ?? "";
						const marker = enabled ? "✓" : "✗";
						return `${marker} ${name}: ${desc}`;
					});
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}

				if ((action === "enable" || action === "disable") && agentName) {
					if (!registry.has(agentName)) {
						ctx.ui.notify(
							`Unknown agent: "${agentName}". Available: ${allNames.join(", ")}`,
							"error",
						);
						return;
					}
					setAgentEnabled(agentName, action === "enable");
					refreshToolDescription(agentTool, registry);
					const state = action === "enable" ? "enabled" : "disabled";
					ctx.ui.notify(`Agent "${agentName}" ${state}\n${formatStatusSummary(allNames)}`, "info");
					return;
				}

				ctx.ui.notify(
					"Usage: /agents [list | enable <name> | disable <name>]",
					"info",
				);
				return;
			}

			// Single-shot selector: each option is a toggle action
			const options = allNames.map((name: string) => {
				const enabled = !isAgentDisabled(name);
				const action = enabled ? "Disable" : "Enable";
				return `${enabled ? "✓" : "✗"} ${name} → ${action}`;
			});

			const choice = await ctx.ui.select("Toggle agent (select to flip)", options);
			if (!choice) return;

			// Extract agent name from "✓ <name> → Disable" or "✗ <name> → Enable"
			const match = choice.match(/^[✓✗]\s+(\S+)\s+→/);
			if (!match) return;
			const agentName = match[1];

			if (agentName && registry.has(agentName)) {
				const currentlyEnabled = !isAgentDisabled(agentName);
				setAgentEnabled(agentName, !currentlyEnabled);
				refreshToolDescription(agentTool, registry);
				const state = currentlyEnabled ? "disabled" : "enabled";
				ctx.ui.notify(`Agent "${agentName}" ${state}\n${formatStatusSummary(allNames)}`, "info");
			}
		},
	});
}
