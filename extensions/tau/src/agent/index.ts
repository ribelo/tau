import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Effect } from "effect";
import { renderAgentCall, renderAgentResult } from "./render.js";
import { createUiApprovalBroker } from "./approval-broker.js";
import type { AgentRuntimeBridgeService } from "./runtime.js";
import { installAgentProcessGuards } from "./process-guards.js";
import { AgentParams, createAgentToolDef } from "./tool.js";
import { ExecutionState } from "../services/execution-state.js";
import { resolveSessionMode } from "../services/execution-resolver.js";
import { makeExecutionProfile } from "../execution/schema.js";
import { readModelId } from "../prompt/profile.js";
import { isPromptModeThinkingLevel } from "./model-spec.js";

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

				const resolveParentExecution = () =>
					runtime.runPromise(
						Effect.gen(function* () {
							const executionState = yield* ExecutionState;
							const state = executionState.getSnapshot();
							const mode = resolveSessionMode(state);
							const model = readModelId(ctx.model);
							if (model === undefined) {
								throw new Error(
									"Cannot spawn agent: current session has no active model",
								);
							}

							const thinking = pi.getThinkingLevel();
							if (!isPromptModeThinkingLevel(thinking)) {
								throw new Error(
									"Cannot spawn agent: current session has no supported thinking level",
								);
							}

							return {
								state,
								profile: makeExecutionProfile({
									selector: {
										mode,
									},
									promptProfile: {
										mode,
										model,
										thinking,
									},
									policy: state.policy,
								}),
							};
						}),
					);

				const toolDef = createAgentToolDef(
					(effect) => runtime.runPromise(effect),
					() => ({
						parentSessionFile: ctx.sessionManager.getSessionFile(),
						parentAgentId: undefined,
						parentModel: ctx.model,
						resolveParentExecution,
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
