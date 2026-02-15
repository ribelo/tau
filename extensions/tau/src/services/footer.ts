import { Context, Effect, Layer, SubscriptionRef } from "effect";

import type { ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { PiAPI } from "../effect/pi.js";
import { isRecord } from "../shared/json.js";
import { Persistence } from "./persistence.js";
import { SandboxState } from "./state.js";

export interface Footer {
	readonly setup: Effect.Effect<void>;
}

export const Footer = Context.GenericTag<Footer>("Footer");

type GitLineDelta = { readonly added: number; readonly removed: number };

type FooterHygiene = {
	readonly gitLineDelta: GitLineDelta;
	readonly inProgressCount: number;
};

const FOOTER_PROVIDER_ALIASES: Record<string, string> = {
	"google-gemini-cli": "gemini-cli",
	"openai-codex": "codex",
};

const resolveFooterProviderLabel = (provider: string | null): string | null => {
	if (!provider) return null;
	return FOOTER_PROVIDER_ALIASES[provider] ?? provider;
};

const formatTokenWindow = (tokens: number): string => {
	if (tokens < 1000) {
		return `${tokens}`;
	}
	if (tokens % 1000 === 0) {
		return `${tokens / 1000}k`;
	}
	return `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k`;
};

const truncateMiddle = (text: string, width: number): string => {
	if (width <= 0) {
		return "";
	}
	if (visibleWidth(text) <= width) {
		return text;
	}
	if (width <= 3) {
		return truncateToWidth(text, width);
	}
	const keep = Math.floor((width - 3) / 2);
	const start = text.slice(0, keep);
	const end = text.slice(text.length - (width - 3 - keep));
	return `${start}...${end}`;
};

const parseGitNumstat = (output: string): GitLineDelta => {
	let added = 0;
	let removed = 0;

	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const [rawAdded, rawRemoved] = trimmed.split("\t");
		if (!rawAdded || !rawRemoved || rawAdded === "-" || rawRemoved === "-") continue;
		const parsedAdded = Number(rawAdded);
		const parsedRemoved = Number(rawRemoved);
		if (!Number.isFinite(parsedAdded) || !Number.isFinite(parsedRemoved)) continue;
		added += parsedAdded;
		removed += parsedRemoved;
	}

	return { added, removed };
};

const collectGitLineDelta = (cwd: string): GitLineDelta => {
	const runNumstat = (args: string[]): GitLineDelta => {
		try {
			const result = spawnSync("git", args, {
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			});
			if (result.status !== 0) {
				return { added: 0, removed: 0 };
			}
			return parseGitNumstat(result.stdout ?? "");
		} catch {
			return { added: 0, removed: 0 };
		}
	};

	const unstaged = runNumstat(["diff", "--numstat", "--no-ext-diff"]);
	const staged = runNumstat(["diff", "--cached", "--numstat", "--no-ext-diff"]);

	return {
		added: unstaged.added + staged.added,
		removed: unstaged.removed + staged.removed,
	};
};

const findBeadsJsonlPath = (startDir: string): string | null => {
	let current = startDir;
	for (;;) {
		const candidate = path.join(current, ".beads", "beads.left.jsonl");
		if (fs.existsSync(candidate)) {
			return candidate;
		}
		const parent = path.dirname(current);
		if (parent === current) {
			return null;
		}
		current = parent;
	}
};

const countInProgressIssuesFromJsonl = (content: string): number => {
	let count = 0;
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (!isRecord(parsed)) continue;
			const status = parsed["status"];
			if (status === "in_progress" || status === "in-progress") {
				count += 1;
			}
		} catch {
			continue;
		}
	}
	return count;
};

const computeTotalCost = (ctx: ExtensionContext): number => {
	let totalCost = 0;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (!isRecord(entry)) continue;
		if (entry["type"] !== "message") continue;
		const message = entry["message"];
		if (!isRecord(message)) continue;
		if (message["role"] !== "assistant") continue;
		const usage = message["usage"];
		if (!isRecord(usage)) continue;
		const cost = usage["cost"];
		if (!isRecord(cost)) continue;
		const total = cost["total"];
		if (typeof total !== "number" || !Number.isFinite(total)) continue;
		totalCost += total;
	}
	return totalCost;
};

export const FooterLive = Layer.effect(
	Footer,
	Effect.gen(function* () {
		const pi = yield* PiAPI;
		const sandboxState = yield* SandboxState;
		const persistence = yield* Persistence;

		const hygieneRef = yield* SubscriptionRef.make<FooterHygiene>({
			gitLineDelta: { added: 0, removed: 0 },
			inProgressCount: 0,
		});
		const totalCostRef = yield* SubscriptionRef.make<number>(0);

		const emitFooterChanged = () => pi.events.emit("tau:footer:changed", null);

		const refreshFooterHygieneOnce = Effect.gen(function* () {
			const cwd = process.cwd();
			const gitLineDelta = collectGitLineDelta(cwd);

			const issuesPath = findBeadsJsonlPath(cwd);
			let inProgressCount = 0;
			if (issuesPath) {
				try {
					const issuesJsonl = fs.readFileSync(issuesPath, "utf8");
					inProgressCount = countInProgressIssuesFromJsonl(issuesJsonl);
				} catch {
					inProgressCount = 0;
				}
			}

			const current = yield* SubscriptionRef.get(hygieneRef);
			if (
				current.gitLineDelta.added === gitLineDelta.added &&
				current.gitLineDelta.removed === gitLineDelta.removed &&
				current.inProgressCount === inProgressCount
			) {
				return;
			}

			yield* SubscriptionRef.set(hygieneRef, { gitLineDelta, inProgressCount });
			yield* Effect.sync(() => emitFooterChanged());
		});

		const refreshFooterHygieneLoop = refreshFooterHygieneOnce.pipe(
			Effect.catchAll(() => Effect.void),
			Effect.zipRight(
				Effect.forever(
					Effect.sleep("5 seconds").pipe(
						Effect.zipRight(refreshFooterHygieneOnce.pipe(Effect.catchAll(() => Effect.void))),
					),
				),
			),
		);

		return Footer.of({
			setup: Effect.gen(function* () {
				// Start hygiene refresh loop (git diff + beads in-progress count)
				yield* Effect.forkDaemon(refreshFooterHygieneLoop);

				yield* Effect.sync(() => {
					pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
						Effect.runSync(SubscriptionRef.set(totalCostRef, computeTotalCost(ctx)));
						emitFooterChanged();

						ctx.ui.setFooter((tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
							const unsubBranch = footerData.onBranchChange(() => tui.requestRender());
							const unsubSandbox = pi.events.on("tau:sandbox:changed", () => tui.requestRender());
							const unsubFooter = pi.events.on("tau:footer:changed", () => tui.requestRender());
							const unsubMode = pi.events.on("tau:mode:changed", () => tui.requestRender());

							return {
								dispose() {
									unsubBranch();
									unsubSandbox();
									unsubFooter();
									unsubMode();
								},
								invalidate() {},
								render(width: number): string[] {
									const sandboxConfig = SubscriptionRef.get(sandboxState).pipe(Effect.runSync);
									const hygiene = SubscriptionRef.get(hygieneRef).pipe(Effect.runSync);
									const totalCost = SubscriptionRef.get(totalCostRef).pipe(Effect.runSync);
									const persisted = SubscriptionRef.get(persistence.state).pipe(Effect.runSync);
									const modeLabel = persisted.promptModes?.activeMode ?? "smart";

									// Status dots
									const dots: string[] = [];

									// FS Dot
									const fsMode = sandboxConfig.filesystemMode ?? "read-only";
									const fsColor =
										fsMode === "danger-full-access"
											? ("error" as const)
											: fsMode === "workspace-write"
												? ("warning" as const)
												: ("success" as const);
									dots.push(theme.fg(fsColor, "•"));

									// Net Dot
									const netMode = sandboxConfig.networkMode ?? "deny";
									const netColor = netMode === "allow-all" ? ("error" as const) : ("success" as const);
									dots.push(theme.fg(netColor, "•"));

									// App Dot (running)
									dots.push(theme.fg("success", "•"));

									const repoName = path.basename(ctx.cwd);
									const branch = footerData.getGitBranch();
									const repoLine = branch ? `${repoName}:${branch}` : repoName;

									const gitLineDeltaText = `Δ+${hygiene.gitLineDelta.added}/-${hygiene.gitLineDelta.removed}`;
									const gitLineDeltaPart = theme.fg("dim", gitLineDeltaText);

									const inProgressText = `ρ${hygiene.inProgressCount}`;
									const inProgressPart = theme.fg("dim", inProgressText);

									const left =
										dots.join(" ") +
										"  " +
										theme.fg("dim", repoLine) +
										" " +
										gitLineDeltaPart +
										" " +
										inProgressPart;

									const providerLabel = resolveFooterProviderLabel(ctx.model?.provider ?? null);
									const model = ctx.model?.id ?? "no-model";
									const thinkingLabel = pi.getThinkingLevel() ?? "off";
									const thinkingStr = ` • ${thinkingLabel}`;
									const modeStr = ` • ${modeLabel}`;
									const modelAndMetaRaw = `${model}${thinkingStr}${modeStr}`;
									const middleRaw = providerLabel ? `${providerLabel} • ${modelAndMetaRaw}` : modelAndMetaRaw;
									const middle = theme.fg("dim", middleRaw);

									const costStr = `$${totalCost.toFixed(3)}`;

									const usage = ctx.getContextUsage();
									const contextWindow = usage?.contextWindow;
									const contextStr =
										typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
											? `${Math.round(usage?.percent ?? 0)}%/${formatTokenWindow(contextWindow)}`
											: null;

									const rightParts = [costStr, contextStr].filter(
										(part): part is string => typeof part === "string" && part.length > 0,
									);
									const right = theme.fg("dim", rightParts.join(" "));

									const leftWidth = visibleWidth(left);
									const middleWidth = visibleWidth(middleRaw);
									const rightWidth = visibleWidth(right);

									let statsLine = left;
									if (Number.isFinite(width) && width > 0) {
										const minGap = 2;
										const fullRequired = leftWidth + middleWidth + rightWidth + minGap * 2;

										if (fullRequired <= width) {
											const free = width - fullRequired;
											const leftGap = minGap + Math.floor(free / 2);
											const rightGap = minGap + Math.ceil(free / 2);
											statsLine = `${left}${" ".repeat(leftGap)}${middle}${" ".repeat(rightGap)}${right}`;
										} else {
											const middleBudget = width - leftWidth - rightWidth - minGap * 2;
											if (middleBudget > 0) {
												const compactMiddleRaw = modelAndMetaRaw;
												const preferredMiddleRaw =
													providerLabel && visibleWidth(compactMiddleRaw) <= middleBudget
														? compactMiddleRaw
														: middleRaw;
												const renderedMiddleRaw =
													visibleWidth(preferredMiddleRaw) <= middleBudget
														? preferredMiddleRaw
														: truncateMiddle(preferredMiddleRaw, middleBudget);
												const renderedMiddle = theme.fg("dim", renderedMiddleRaw);
												const consumed =
													leftWidth + visibleWidth(renderedMiddleRaw) + rightWidth + minGap * 2;
												const free = Math.max(0, width - consumed);
												const leftGap = minGap + Math.floor(free / 2);
												const rightGap = minGap + Math.ceil(free / 2);
												statsLine = `${left}${" ".repeat(leftGap)}${renderedMiddle}${" ".repeat(rightGap)}${right}`;
											} else {
												const padding = " ".repeat(Math.max(1, width - leftWidth - rightWidth));
												statsLine = `${left}${padding}${right}`;
											}
										}
									} else {
										statsLine = `${left}  ${middle}  ${right}`;
									}

									return [truncateToWidth(statsLine, width)];
								},
							};
						});
					});

					pi.on("turn_end", (_event: unknown, ctx: ExtensionContext) => {
						Effect.runSync(SubscriptionRef.set(totalCostRef, computeTotalCost(ctx)));
						emitFooterChanged();
					});
					pi.on("session_tree", () => emitFooterChanged());
					pi.on("session_fork", () => emitFooterChanged());
					pi.on("model_select", () => emitFooterChanged());
				});
			}),
		});
	}),
);
