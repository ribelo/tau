import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { AgentRegistry } from "../agent/agent-registry.js";
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

export default function initAgentsMenu(pi: ExtensionAPI): void {
	// Reset on session boundaries
	pi.on("session_start", async () => {
		resetAgentStates();
	});
	pi.on("session_switch", async () => {
		resetAgentStates();
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
					const state = action === "enable" ? "enabled" : "disabled";
					ctx.ui.notify(`Agent "${agentName}" ${state}`, "info");
					return;
				}

				ctx.ui.notify(
					"Usage: /agents [list | enable <name> | disable <name>]",
					"info",
				);
				return;
			}

			// Interactive toggle loop
			let done = false;
			while (!done) {
				const options = allNames.map((name: string) => {
					const enabled = !isAgentDisabled(name);
					return `${enabled ? "✓" : "✗"} ${name}`;
				});
				options.push("── Done ──");

				const choice = await ctx.ui.select("Toggle agents", options);
				if (!choice || choice === "── Done ──") {
					done = true;
					continue;
				}

				const agentName = choice.replace(/^[✓✗]\s+/, "");
				if (registry.has(agentName)) {
					const currentlyEnabled = !isAgentDisabled(agentName);
					setAgentEnabled(agentName, !currentlyEnabled);
				}
			}

			const disabled = allNames.filter((name: string) => isAgentDisabled(name));
			if (disabled.length === 0) {
				ctx.ui.notify("All agents enabled", "info");
			} else {
				ctx.ui.notify(`Disabled agents: ${disabled.join(", ")}`, "info");
			}
		},
	});
}
