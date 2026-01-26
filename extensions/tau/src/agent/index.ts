import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { renderAgentCall, renderAgentResult } from "./render.js";
import { createUiApprovalBroker } from "./approval-broker.js";
import { initAgentRuntime, getAgentRuntime } from "./runtime.js";
import { AgentParams, buildToolDescription, createAgentToolDef } from "./tool.js";

export default function initAgent(pi: ExtensionAPI) {
	// Initialize the shared runtime
	initAgentRuntime(pi);

	pi.registerTool({
		name: "agent",
		label: "agent",
		description: buildToolDescription(),
		parameters: AgentParams,

		async execute(_toolCallId, params, _onUpdate, ctx, _signal) {
			const approvalBroker =
				ctx.hasUI && ctx.ui && typeof ctx.ui.confirm === "function"
					? createUiApprovalBroker(ctx.ui)
					: undefined;

			const runtime = getAgentRuntime();
			const toolDef = createAgentToolDef(
				(effect) => runtime.runPromise(effect),
				() => ({
					parentSessionId: ctx.sessionManager.getSessionId(),
					parentModel: ctx.model,
					cwd: ctx.cwd,
					approvalBroker,
				}),
			);

			return toolDef.execute(_toolCallId, params, _onUpdate, ctx, _signal);
		},

		renderCall(args, theme) {
			return renderAgentCall(args, theme);
		},
		renderResult(result, options, theme) {
			return renderAgentResult(result, options, theme);
		},
	});
}

// Re-export for external use
export { getAgentRuntime, createWorkerAgentTool } from "./runtime.js";
