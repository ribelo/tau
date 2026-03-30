import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { renderAgentCall, renderAgentResult } from "./render.js";
import { createUiApprovalBroker } from "./approval-broker.js";
import type { AgentRuntimeBridgeService } from "./runtime.js";
import { installAgentProcessGuards } from "./process-guards.js";
import { AgentParams, createAgentToolDef } from "./tool.js";

export interface AgentToolHandle {
	/** Re-register the agent tool with an updated description. */
	refresh(description: string): void;
}

export default function initAgent(
	pi: ExtensionAPI,
	runtime: AgentRuntimeBridgeService,
	description: string,
): AgentToolHandle {
	// Guard against unhandled errors inside background agent loops (e.g., auth expiration)
	installAgentProcessGuards(pi, runtime.closeAll);

	// Close all agents when session switches (e.g., /new command)
	pi.on("session_switch", async () => {
		await runtime.closeAll();
	});

	let currentDescription = description;

	const registerAgentTool = (desc: string) => {
		currentDescription = desc;
		pi.registerTool({
			name: "agent",
			label: "agent",
			description: desc,
			promptSnippet: "Manage non-blocking agent tasks (spawn, send, wait, close, list)",
			promptGuidelines: [
				"Use all the tools available to you.",
				"For complex tasks requiring deep analysis, planning, or debugging across multiple files, use an expert reasoning subagent and then validate findings with your own investigation.",
			],
			parameters: AgentParams,

			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const approvalBroker =
					ctx.hasUI && ctx.ui && typeof ctx.ui.confirm === "function"
						? createUiApprovalBroker(ctx.ui)
						: undefined;

				const toolDef = createAgentToolDef(
					(effect) => runtime.runPromise(effect),
					() => ({
						parentSessionId: ctx.sessionManager.getSessionId(),
						parentAgentId: undefined,
						parentModel: ctx.model,
						modelRegistry: ctx.modelRegistry,
						cwd: ctx.cwd,
						approvalBroker,
					}),
					currentDescription,
				);

				return toolDef.execute(toolCallId, params, signal, onUpdate, ctx);
			},

			renderCall(args, theme) {
				return renderAgentCall(args, theme);
			},
			renderResult(result, options, theme) {
				return renderAgentResult(result, options, theme);
			},
		});
	};

	registerAgentTool(description);

	return {
		refresh: registerAgentTool,
	};
}
