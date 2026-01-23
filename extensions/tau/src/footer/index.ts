import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { execSync } from "node:child_process";
import { basename } from "node:path";

import type { TauState } from "../shared/state.js";
import { getEffectiveSandboxConfig } from "../sandbox/index.js";

/**
 * Format token counts
 */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function getGitDiffStats(cwd: string): string {
	return "";
}

export default function initFooter(pi: ExtensionAPI, state: TauState) {
	pi.on("session_start", (event, ctx) => {
		setupFooter(pi, state, ctx);
	});

	// Refresh on branch switch or other events if needed
	pi.on("session_tree", async (event, ctx) => setupFooter(pi, state, ctx));
	pi.on("session_fork", async (event, ctx) => setupFooter(pi, state, ctx));
	pi.on("turn_end", async (event, ctx) => setupFooter(pi, state, ctx));
	pi.on("model_select", async (event, ctx) => setupFooter(pi, state, ctx));
	pi.on("tool_result", async (event, ctx) => {
		setupFooter(pi, state, ctx);
	});
}

function setupFooter(pi: ExtensionAPI, state: TauState, ctx: ExtensionContext) {
	ctx.ui.setFooter((tui, theme, footerData) => {
		const unsubBranch = footerData.onBranchChange(() => tui.requestRender());
		const unsubSandbox = pi.events.on("tau:sandbox:changed", () => {
			tui.requestRender();
		});

		return {
			dispose() {
				unsubBranch();
				unsubSandbox();
			},
			invalidate() {},
			render(width: number): string[] {
				const config = getEffectiveSandboxConfig(state, ctx);
				
				// 1. Sandbox Dots (Hardcoded ANSI for high contrast in Alacritty)
				const green = "\x1b[32m";
				const yellow = "\x1b[33m";
				const red = "\x1b[31m";
				const reset = "\x1b[39m";

				const fsDotRaw = config.filesystemMode === "read-only" ? green : config.filesystemMode === "workspace-write" ? yellow : red;
				const fsDot = `${fsDotRaw}•${reset}`;
						
				const netDotRaw = config.networkMode === "deny" ? green : red;
				const netDot = `${netDotRaw}•${reset}`;
						
				const appDotRaw = config.approvalPolicy === "never" ? green : config.approvalPolicy === "on-failure" ? yellow : red;
				const appDot = `${appDotRaw}•${reset}`;

				// 2. Subscription Dot
				const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
				const subDot = usingSubscription ? theme.fg("success", "•") : theme.fg("dim", "•");

				const dots = `${fsDot} ${netDot} ${appDot} ${subDot}`;

				// 3. Repo & Git
				const repoName = basename(ctx.cwd);
				const branch = footerData.getGitBranch();
				const branchStr = branch ? ` (${branch})` : "";
				const diffStats = getGitDiffStats(ctx.cwd);
				const repoGit = theme.fg("dim", `${repoName}${branchStr}${diffStats}`);

				// 4. Model Info
				const provider = ctx.model?.provider || "unknown";
				const modelId = ctx.model?.id || "no-model";
				const thinking = pi.getThinkingLevel() || "off";
				const modelInfo = theme.fg("dim", `${provider} • ${modelId}${thinking !== "off" ? ` • ${thinking}` : ""}`);

				// 5. Usage & Context
				let totalCost = 0;
				for (const entry of ctx.sessionManager.getBranch()) {
					if (entry.type === "message" && entry.message.role === "assistant") {
						const m = entry.message as AssistantMessage;
						totalCost += m.usage.cost.total;
					}
				}

				const usage = ctx.getContextUsage();
				const contextTokens = usage ? usage.tokens : 0;
				const contextWindow = usage ? usage.contextWindow : (ctx.model?.contextWindow || 0);
				const contextPercentValue = contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;
				const contextPercent = contextPercentValue.toFixed(1);

				const costStr = theme.fg("dim", `$${totalCost.toFixed(3)}`);
				
				let contextPercentStr: string;
				const contextDisplay = `${contextPercent}%/${formatTokens(contextWindow)}`;
				if (contextPercentValue > 90) {
					contextPercentStr = theme.fg("error", contextDisplay);
				} else if (contextPercentValue > 70) {
					contextPercentStr = theme.fg("warning", contextDisplay);
				} else {
					contextPercentStr = theme.fg("dim", contextDisplay);
				}

				const leftParts = [
					dots,
					repoGit,
					modelInfo,
				];

				const left = leftParts.join(" ");
				const right = `${costStr} ${contextPercentStr}`;

				const leftWidth = visibleWidth(left);
				const rightWidth = visibleWidth(right);

				const padding = " ".repeat(Math.max(1, width - leftWidth - rightWidth));
				const content = left + padding + right;

				return [truncateToWidth(content, width)];
			},
		};
	});
}
