import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import type { TauState } from "../../shared/state.js";
import { updatePersistedState } from "../../shared/state.js";
import { discoverWorkspaceRoot } from "../workspace-root.js";
import { countOverlappingAgents } from "./detection.js";
import { buildAgentContextNotice, injectAgentContextIntoMessages } from "./injection.js";

function buildConcurrentAgentInstructions(): string {
	return [
		"<concurrent_agent_instructions>",
		"Multiple pi agents may work concurrently in overlapping directories.",
		"The current state is injected as AGENT_CONTEXT: ... in user messages.",
		"",
		"When other agents are detected:",
		"- avoid destructive git commands (restore/checkout/reset/clean, force pushes, rebases)",
		"- avoid bulk deletes (rm -rf, find -delete)",
		"- prefer reading files before editing them",
		"- if uncertain about file ownership, ask the user for confirmation",
		"</concurrent_agent_instructions>",
	].join("\n");
}

export default function initAgentAwareness(pi: ExtensionAPI, state: TauState) {
	pi.on("before_agent_start", async (event) => {
		const already = state.persisted.agentAwareness?.instructionsInjected;
		if (already) return;

		updatePersistedState(pi, state, { agentAwareness: { instructionsInjected: true } });

		const instructions = buildConcurrentAgentInstructions();
		return { systemPrompt: `${event.systemPrompt}\n\n${instructions}` };
	});

	pi.on("context", async (event, ctx) => {
		const ourGitRoot = discoverWorkspaceRoot(ctx.cwd);
		const { count, pids } = countOverlappingAgents(ctx.cwd, ourGitRoot);

		const previous = state.persisted.agentAwareness?.lastAgentCount;
		const droppedToZero = typeof previous === "number" && previous > 0 && count === 0;

		// Persist only on changes (avoid bloating session history).
		if (previous !== count) {
			updatePersistedState(pi, state, { agentAwareness: { lastAgentCount: count } });
		}

		if (count <= 0 && !droppedToZero) return;

		const notice = buildAgentContextNotice({ count, pids });
		const nextMessages = injectAgentContextIntoMessages(event.messages, notice);
		return { messages: nextMessages };
	});
}

