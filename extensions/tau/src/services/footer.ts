import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect";

import { PiAPI } from "../effect/pi.js";
import { SandboxState } from "./state.js";
import { truncateToWidth, visibleWidth, type TUI } from "@mariozechner/pi-tui";
import { basename } from "node:path";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { SandboxConfigRequired } from "../schemas/config.js";
import type { ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@mariozechner/pi-coding-agent";

export interface Footer {
	readonly setup: Effect.Effect<void>;
}

export const Footer = Context.GenericTag<Footer>("Footer");

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export const FooterLive = Layer.effect(
	Footer,
	Effect.gen(function* () {
		const pi = yield* PiAPI;
		const state = yield* SandboxState;

		return Footer.of({
			setup: Effect.gen(function* () {
				yield* Effect.logInfo("Setting up Footer service");

				yield* Effect.sync(() => {
					pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
						ctx.ui.setFooter((tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
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
									// We can't use yield* here, so we'll use SubscriptionRef.getSync if available
									// or just get it from the event or a local cache.
									// For now, let's use the SubscriptionRef value.
									const config = SubscriptionRef.get(state).pipe(Effect.runSync);

									// 1. Sandbox Dots (Hardcoded ANSI for high contrast in Alacritty)
									const green = "\x1b[32m";
									const yellow = "\x1b[33m";
									const red = "\x1b[31m";
									const reset = "\x1b[39m";

									const fsDotRaw =
										config.filesystemMode === "read-only"
											? green
											: config.filesystemMode === "workspace-write"
												? yellow
												: red;
									const fsDot = `${fsDotRaw}•${reset}`;

									const netDotRaw = config.networkMode === "deny" ? green : red;
									const netDot = `${netDotRaw}•${reset}`;

									const appDotRaw =
										config.approvalPolicy === "never"
											? green
											: config.approvalPolicy === "on-failure"
												? yellow
												: red;
									const appDot = `${appDotRaw}•${reset}`;

									// 2. Subscription Dot
									const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
									const subDot = usingSubscription ? theme.fg("success", "•") : theme.fg("dim", "•");

									const dots = `${fsDot} ${netDot} ${appDot} ${subDot}`;

									// 3. Repo & Git
									const repoName = basename(ctx.cwd);
									const branch = footerData.getGitBranch();
									const branchStr = branch ? ` (${branch})` : "";
									const repoGit = theme.fg("dim", `${repoName}${branchStr}`);

									// 4. Model Info
									const provider = ctx.model?.provider || "unknown";
									const modelId = ctx.model?.id || "no-model";
									const thinking = pi.getThinkingLevel() || "off";
									const modelInfo = theme.fg(
										"dim",
										`${provider} • ${modelId}${thinking !== "off" ? ` • ${thinking}` : ""}`,
									);

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
									const contextWindow = usage ? usage.contextWindow : ctx.model?.contextWindow || 0;
									const contextPercentValue =
										contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;
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

									const leftParts = [dots, repoGit, modelInfo];

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
					});
				});
			}),
		});
	}),
);
