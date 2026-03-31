import * as fs from "node:fs";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import type { ForgeReviewResult, ForgeState } from "./types.js";
import {
	loadState,
	saveState,
	deleteForge,
	listForges,
	findActiveForge,
} from "./state.js";
import {
	buildImplementPrompt,
	buildReviewPrompt,
	implementSystemSnippet,
	reviewSystemSnippet,
} from "./prompts.js";
import { readMaterializedIssuesCache } from "../backlog/materialize.js";
import { resolveBacklogPaths } from "../backlog/contract.js";
import { parseMaterializedIssues } from "../backlog/materialize.js";
import { setIssueStatus } from "../backlog/events.js";
import { parseProviderModel } from "../shared/model-id.js";

type AgentTextContent = {
	readonly type: "text";
	readonly text: string;
};

type AgentMessage = {
	readonly role: string;
	readonly content?: readonly AgentTextContent[];
};

type AgentEndEvent = {
	readonly messages?: readonly AgentMessage[];
};

/** Read a backlog item's title and description via internal backlog API. */
async function readBacklogItem(
	cwd: string,
	taskId: string,
): Promise<{ title: string; description: string } | undefined> {
	try {
		const issues = await readMaterializedIssuesCache(cwd);
		const issue = issues.find((i) => i.id === taskId);
		if (!issue) return undefined;
		return {
			title: issue.title,
			description: issue.description ?? "(no description)",
		};
	} catch {
		return undefined;
	}
}

/** Close a backlog item via internal backlog API. Returns true on success. */
async function closeBacklogItem(
	cwd: string,
	taskId: string,
	reason: string,
): Promise<boolean> {
	try {
		await setIssueStatus(cwd, {
			issueId: taskId,
			actor: "forge",
			status: "closed",
			reason,
		});
		return true;
	} catch {
		return false;
	}
}

/** Resolve a model object from a model ID string via the model registry.
 * Accepts both plain id ("gpt-5.4-mini") and qualified "provider/id" format. */
function resolveModel(
	ctx: { modelRegistry: import("@mariozechner/pi-coding-agent").ModelRegistry },
	modelId: string,
): import("@mariozechner/pi-ai").Model<import("@mariozechner/pi-ai").Api> | undefined {
	const all = ctx.modelRegistry.getAll();
	// Try exact id match first
	const exact = all.find((m) => m.id === modelId);
	if (exact) return exact;
	// Try provider/id format
	const parsed = parseProviderModel(modelId);
	if (parsed) {
		return all.find((m) => m.provider === parsed.provider && m.id === parsed.modelId);
	}
	// Try matching by name
	return all.find((m) => m.name === modelId);
}

function currentModelId(
	ctx: Pick<import("@mariozechner/pi-coding-agent").ExtensionContext, "model">,
): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

export default function initForge(pi: ExtensionAPI): void {
	/** The task ID of the currently active forge in this session, if any. */
	let activeTaskId: string | undefined;
	let reviewToolRestore: string[] | undefined;

	/** Resolve callback for the current waitForAgentEnd promise, if any. */
	let agentEndResolve: ((event: AgentEndEvent) => void) | undefined;

	/** Wait for the next agent_end event. Set up BEFORE sending a message. */
	function waitForAgentEnd(): Promise<AgentEndEvent> {
		return new Promise<AgentEndEvent>((resolve) => {
			agentEndResolve = resolve;
		});
	}

	// ── Tool activation helpers ──────────────────────────────────────

	const REVIEW_BLOCKED_TOOLS = ["edit", "write", "git_commit_with_user_approval"];

	function activateReviewTools(): void {
		if (!reviewToolRestore) {
			reviewToolRestore = [...pi.getActiveTools()];
		}
		pi.setActiveTools(reviewToolRestore.filter((t) => !REVIEW_BLOCKED_TOOLS.includes(t)));
	}

	function restoreReviewTools(): void {
		if (!reviewToolRestore) return;
		pi.setActiveTools(reviewToolRestore);
		reviewToolRestore = undefined;
	}

	// ── UI helpers ───────────────────────────────────────────────────

	function updateUI(
		cwd: string,
		ctx: { hasUI: boolean; ui: import("@mariozechner/pi-coding-agent").ExtensionUIContext },
	): void {
		if (!ctx.hasUI) return;

		if (!activeTaskId) {
			ctx.ui.setStatus("forge", undefined);
			ctx.ui.setWidget("forge", undefined);
			return;
		}

		const state = loadState(cwd, activeTaskId);
		if (!state || state.status !== "active") {
			ctx.ui.setStatus("forge", undefined);
			ctx.ui.setWidget("forge", undefined);
			return;
		}

		const { theme } = ctx.ui;

		ctx.ui.setStatus(
			"forge",
			theme.fg("accent", `forge: ${state.taskId} [${state.phase} #${state.cycle}]`),
		);

		const lines = [
			theme.fg("accent", theme.bold("Forge")),
			theme.fg("muted", `Task: ${state.taskId}`),
			theme.fg("dim", `Phase: ${state.phase}`),
			theme.fg("dim", `Cycle: ${state.cycle}`),
			theme.fg("dim", `Status: ${state.status}`),
		];
		if (state.reviewer.model) {
			lines.push(theme.fg("dim", `Reviewer model: ${state.reviewer.model}`));
		}
		ctx.ui.setWidget("forge", lines);
	}

	/** Apply reviewer model and thinking level if configured. */
	async function applyReviewerConfig(
		ctx: import("@mariozechner/pi-coding-agent").ExtensionContext,
		state: ForgeState,
	): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
		if (state.reviewer.model) {
			const reviewerModel = resolveModel(ctx, state.reviewer.model);
			if (!reviewerModel) {
				return {
					ok: false,
					reason: `Reviewer model not found: ${state.reviewer.model}`,
				};
			}
			const ok = await pi.setModel(reviewerModel);
			if (!ok) {
				return {
					ok: false,
					reason: `No auth available for reviewer model: ${state.reviewer.model}`,
				};
			}
		}
		if (state.reviewer.thinking) {
			pi.setThinkingLevel(state.reviewer.thinking as import("@mariozechner/pi-ai").ThinkingLevel);
		}
		return { ok: true };
	}

	function rememberImplementerConfig(
		ctx: import("@mariozechner/pi-coding-agent").ExtensionContext,
		state: ForgeState,
		options?: { readonly overwrite?: boolean },
	): void {
		const overwrite = options?.overwrite === true;
		if (!overwrite && state.implementer) return;

		const model = currentModelId(ctx);
		const thinking = pi.getThinkingLevel();
		const next = {
			...(model ? { model } : {}),
			...(thinking ? { thinking } : {}),
		};

		if (
			state.implementer?.model === next.model &&
			state.implementer?.thinking === next.thinking
		) {
			return;
		}

		state.implementer = next;
		saveState(ctx.cwd, state);
	}

	async function restoreImplementerConfig(
		ctx: import("@mariozechner/pi-coding-agent").ExtensionContext,
		state: ForgeState,
	): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
		if (state.implementer?.model) {
			const implementerModel = resolveModel(ctx, state.implementer.model);
			if (!implementerModel) {
				return {
					ok: false,
					reason: `Implementer model not found: ${state.implementer.model}`,
				};
			}
			const ok = await pi.setModel(implementerModel);
			if (!ok) {
				return {
					ok: false,
					reason: `No auth available for implementer model: ${state.implementer.model}`,
				};
			}
		}

		if (state.implementer?.thinking) {
			pi.setThinkingLevel(state.implementer.thinking as import("@mariozechner/pi-ai").ThinkingLevel);
		}

		return { ok: true };
	}

	function extractLastAssistantText(event: AgentEndEvent): string {
		const lastAssistant = [...(event.messages ?? [])]
			.reverse()
			.find((message) => message.role === "assistant");
		if (!lastAssistant?.content) return "";

		return lastAssistant.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
	}

	function isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null;
	}

	function isFiniteNumber(value: unknown): value is number {
		return typeof value === "number" && Number.isFinite(value);
	}

	function parseReviewResult(text: string):
		| { readonly ok: true; readonly value: ForgeReviewResult }
		| { readonly ok: false; readonly reason: string } {
		let parsed: unknown;
		try {
			parsed = JSON.parse(text) as unknown;
		} catch (error) {
			return {
				ok: false,
				reason: `Reviewer output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
			};
		}

		if (!isRecord(parsed)) {
			return { ok: false, reason: "Reviewer output must be a JSON object." };
		}

		const findings = parsed["findings"];
		const overallCorrectness = parsed["overall_correctness"];
		const overallExplanation = parsed["overall_explanation"];
		const overallConfidenceScore = parsed["overall_confidence_score"];

		if (!Array.isArray(findings)) {
			return { ok: false, reason: "Reviewer JSON must include an array field 'findings'." };
		}
		if (
			overallCorrectness !== "patch is correct" &&
			overallCorrectness !== "patch is incorrect"
		) {
			return {
				ok: false,
				reason: "Reviewer JSON must include overall_correctness as 'patch is correct' or 'patch is incorrect'.",
			};
		}
		if (typeof overallExplanation !== "string") {
			return { ok: false, reason: "Reviewer JSON must include a string field 'overall_explanation'." };
		}
		if (!isFiniteNumber(overallConfidenceScore)) {
			return { ok: false, reason: "Reviewer JSON must include a numeric field 'overall_confidence_score'." };
		}

		const normalizedFindings: ForgeReviewResult["findings"] = [];
		for (const finding of findings) {
			if (!isRecord(finding)) {
				return { ok: false, reason: "Each finding must be a JSON object." };
			}
			if (typeof finding["title"] !== "string" || typeof finding["body"] !== "string") {
				return { ok: false, reason: "Each finding must include string fields 'title' and 'body'." };
			}
			if (!isFiniteNumber(finding["confidence_score"]) || !isFiniteNumber(finding["priority"])) {
				return { ok: false, reason: "Each finding must include numeric confidence_score and priority fields." };
			}
			const codeLocation = finding["code_location"];
			if (!isRecord(codeLocation) || typeof codeLocation["absolute_file_path"] !== "string") {
				return { ok: false, reason: "Each finding must include code_location.absolute_file_path." };
			}
			const lineRange = codeLocation["line_range"];
			if (
				!isRecord(lineRange) ||
				!isFiniteNumber(lineRange["start"]) ||
				!isFiniteNumber(lineRange["end"])
			) {
				return { ok: false, reason: "Each finding must include numeric code_location.line_range.start/end fields." };
			}

			normalizedFindings.push({
				title: finding["title"],
				body: finding["body"],
				confidence_score: finding["confidence_score"],
				priority: finding["priority"],
				code_location: {
					absolute_file_path: codeLocation["absolute_file_path"],
					line_range: {
						start: lineRange["start"],
						end: lineRange["end"],
					},
				},
			});
		}

		const value: ForgeReviewResult = {
			findings: normalizedFindings,
			overall_correctness: overallCorrectness,
			overall_explanation: overallExplanation,
			overall_confidence_score: overallConfidenceScore,
		};
		if (value.findings.length === 0 && value.overall_correctness !== "patch is correct") {
			return {
				ok: false,
				reason: "Reviewer JSON is inconsistent: empty findings require overall_correctness to be 'patch is correct'.",
			};
		}

		return { ok: true, value };
	}

	function pauseForge(
		ctx: import("@mariozechner/pi-coding-agent").ExtensionContext,
		state: ForgeState,
		message: string,
		level: "warning" | "error" = "warning",
	): void {
		state.status = "paused";
		saveState(ctx.cwd, state);
		activeTaskId = undefined;
		restoreReviewTools();
		updateUI(ctx.cwd, ctx);
		if (ctx.hasUI) {
			ctx.ui.notify(message, level);
		}
	}

	// ── Core loop ────────────────────────────────────────────────────

	/**
	 * Run the forge implement-review loop. Called from /forge start and /forge resume.
	 * The command handler drives the loop: send prompt -> waitForIdle -> check state -> newSession -> repeat.
	 */
	async function runForgeLoop(
		ctx: ExtensionCommandContext,
		taskId: string,
	): Promise<void> {
		while (true) {
			const state = loadState(ctx.cwd, taskId);
			if (!state || state.status !== "active") break;

			const item = await readBacklogItem(ctx.cwd, taskId);
			const title = item?.title ?? taskId;
			const description = item?.description ?? "(no description)";

			if (state.phase === "implementing") {
				rememberImplementerConfig(ctx, state, { overwrite: true });
				restoreReviewTools();
				updateUI(ctx.cwd, ctx);

				const agentDone = waitForAgentEnd();
				pi.sendUserMessage(
					buildImplementPrompt(state, title, description),
				);
				const event = await agentDone;

				// Check what happened
				const after = loadState(ctx.cwd, taskId);
				if (!after || after.status !== "active") break;

				const implementerMessage = extractLastAssistantText(event);
				if (implementerMessage.length === 0) {
					pauseForge(
						ctx,
						after,
						"Implementation ended without an assistant message. Forge paused. Use /forge resume to continue.",
					);
					break;
				}

				after.lastImplementerMessage = implementerMessage;
				after.phase = "reviewing";
				saveState(ctx.cwd, after);

				// Transition to review: fresh session
				const result = await ctx.newSession();
				if (result.cancelled) {
					pauseForge(ctx, after, "Session cancelled. Forge paused.");
					break;
				}

				// Loop continues -- next iteration picks up reviewing phase
				continue;
			}

			if (state.phase === "reviewing") {
				rememberImplementerConfig(ctx, state);
				const reviewerConfig = await applyReviewerConfig(ctx, state);
				if (!reviewerConfig.ok) {
					pauseForge(ctx, state, `Forge paused. ${reviewerConfig.reason}`, "error");
					break;
				}
				activateReviewTools();
				updateUI(ctx.cwd, ctx);

				const agentDone = waitForAgentEnd();
				pi.sendUserMessage(
					buildReviewPrompt(state, title, description),
				);
				const event = await agentDone;

				// Check what happened
				const after = loadState(ctx.cwd, taskId);
				if (!after) break;
				if (after.status !== "active") break;

				const reviewText = extractLastAssistantText(event);
				if (reviewText.length === 0) {
					pauseForge(
						ctx,
						after,
						"Review ended without a JSON response. Forge paused. Use /forge resume to continue.",
					);
					break;
				}

				const reviewResult = parseReviewResult(reviewText);
				if (!reviewResult.ok) {
					pauseForge(
						ctx,
						after,
						`Review output is invalid. ${reviewResult.reason} Forge paused. Use /forge resume to continue.`,
						"error",
					);
					break;
				}

				after.lastReview = reviewResult.value;
				after.lastFeedback = reviewText;

				if (reviewResult.value.findings.length === 0) {
					const closed = await closeBacklogItem(
						ctx.cwd,
						after.taskId,
						`Forge review passed after ${after.cycle} cycle(s).`,
					);
					if (!closed) {
						pauseForge(
							ctx,
							after,
							`Failed to close backlog item ${after.taskId}. Forge paused. Close it manually or resume after fixing backlog state.`,
							"error",
						);
						break;
					}

					after.status = "completed";
					after.completedAt = new Date().toISOString();
					saveState(ctx.cwd, after);

					const restored = await restoreImplementerConfig(ctx, after);
					if (!restored.ok && ctx.hasUI) {
						ctx.ui.notify(`Forge completed, but could not restore implementer config. ${restored.reason}`, "warning");
					}
					// Review approved, task closed
					activeTaskId = undefined;
					restoreReviewTools();
					updateUI(ctx.cwd, ctx);
					ctx.ui.notify(
						`Forge complete: ${taskId} (${after.cycle} cycles)`,
						"info",
					);
					break;
				}

				after.cycle++;
				after.phase = "implementing";
				saveState(ctx.cwd, after);

				const restored = await restoreImplementerConfig(ctx, after);
				if (!restored.ok) {
					pauseForge(ctx, after, `Forge paused. ${restored.reason}`, "error");
					break;
				}

				// Transition to implement: fresh session
				const result = await ctx.newSession();
				if (result.cancelled) {
					pauseForge(ctx, after, "Session cancelled. Forge paused.");
					break;
				}

				// Loop continues -- next iteration picks up implementing phase
				continue;
			}

			break; // unknown phase
		}
	}

	// ── Commands ─────────────────────────────────────────────────────

	const FORGE_HELP = `Forge -- implement-review loop on backlog items

Commands:
  /forge start <task-id>                Start forge loop on a backlog task
  /forge stop                           Pause active forge (press ESC first if agent is running)
  /forge resume <task-id>               Resume a paused forge
  /forge status                         Show all forges
  /forge set <task-id> <model> [<thinking>]  Set reviewer (thinking: minimal/low/medium/high/xhigh)
  /forge cancel <task-id>               Delete forge state`;

	pi.registerCommand("forge", {
		description: "Forge -- implement-review loop on backlog items",
		getArgumentCompletions(prefix: string) {
			const tokens = prefix.trimStart().split(/\s+/);
			if (tokens.length <= 1) {
				const subs = ["start", "stop", "resume", "status", "set", "cancel"];
				const partial = tokens[0] ?? "";
				const matching = subs.filter((s) => s.startsWith(partial));
				return matching.length > 0
					? matching.map((s) => ({ label: s, value: s }))
					: null;
			}

			const sub = tokens[0];
			const partial = tokens[1] ?? "";

			if (tokens.length === 2) {
				if (sub === "start") {
					try {
						const paths = resolveBacklogPaths(process.cwd());
						const raw = fs.readFileSync(paths.materializedIssuesPath, "utf-8");
						const issues = parseMaterializedIssues(raw);
						return issues
							.filter((i) => i.status !== "closed" && i.status !== "tombstone")
							.filter((i) => i.id.startsWith(partial))
							.slice(0, 20)
							.map((i) => ({ label: i.id, value: `${sub} ${i.id}`, description: i.title }));
					} catch {
						return null;
					}
				}
				if (sub === "resume") {
					const forges = listForges(process.cwd()).filter((s) => s.status === "paused");
					return forges
						.filter((s) => s.taskId.startsWith(partial))
						.map((s) => ({ label: s.taskId, value: `${sub} ${s.taskId}`, description: `paused, cycle ${s.cycle}` }));
				}
				if (sub === "set" || sub === "cancel") {
					const forges = listForges(process.cwd());
					const forgeItems = forges
						.filter((s) => s.taskId.startsWith(partial))
						.map((s) => ({ label: s.taskId, value: `${sub} ${s.taskId}`, description: `${s.status}, cycle ${s.cycle}` }));
					if (forgeItems.length > 0) return forgeItems;
					if (sub === "set") {
						try {
							const paths = resolveBacklogPaths(process.cwd());
							const raw = fs.readFileSync(paths.materializedIssuesPath, "utf-8");
							const issues = parseMaterializedIssues(raw);
							return issues
								.filter((i) => i.status !== "closed" && i.status !== "tombstone")
								.filter((i) => i.id.startsWith(partial))
								.slice(0, 20)
								.map((i) => ({ label: i.id, value: `${sub} ${i.id}`, description: i.title }));
						} catch {
							return null;
						}
					}
					return null;
				}
			}

			return null;
		},

		async handler(args, ctx) {
			const tokens = args.trim().split(/\s+/);
			const cmd = tokens[0];
			const rest = tokens.slice(1);

			switch (cmd) {
				case "start": {
					const taskId = rest[0];
					if (!taskId) {
						ctx.ui.notify("Usage: /forge start <task-id>", "warning");
						return;
					}

					const existing = findActiveForge(ctx.cwd);
					if (existing) {
						ctx.ui.notify(
							`Forge already active on ${existing.taskId}. Stop it first with /forge stop.`,
							"warning",
						);
						return;
					}

					const prev = loadState(ctx.cwd, taskId);
					if (prev?.status === "active") {
						ctx.ui.notify(
							`Forge already active on ${taskId}. Use /forge resume ${taskId}.`,
							"warning",
						);
						return;
					}

					const item = await readBacklogItem(ctx.cwd, taskId);
					if (!item) {
						ctx.ui.notify(`Backlog item ${taskId} not found.`, "error");
						return;
					}

					const state: ForgeState = prev?.status === "paused"
						? { ...prev, status: "active", cycle: 1, phase: "implementing", startedAt: new Date().toISOString() }
						: {
							taskId,
							phase: "implementing",
							cycle: 1,
							status: "active",
							reviewer: {},
							startedAt: new Date().toISOString(),
						};

					saveState(ctx.cwd, state);
					activeTaskId = taskId;

					ctx.ui.notify(`Forge started on ${taskId} (cycle 1)`, "info");
					await runForgeLoop(ctx, taskId);
					return;
				}

				case "stop": {
					if (!activeTaskId) {
						const active = findActiveForge(ctx.cwd);
						if (!active) {
							ctx.ui.notify("No active forge.", "warning");
							return;
						}
						activeTaskId = active.taskId;
					}

					const state = loadState(ctx.cwd, activeTaskId);
					if (state) {
						state.status = "paused";
						saveState(ctx.cwd, state);
					}

					const paused = activeTaskId;
					activeTaskId = undefined;
					restoreReviewTools();
					updateUI(ctx.cwd, ctx);
					ctx.ui.notify(`Forge paused: ${paused}`, "info");
					return;
				}

				case "resume": {
					const taskId = rest[0];
					if (!taskId) {
						ctx.ui.notify("Usage: /forge resume <task-id>", "warning");
						return;
					}

					const state = loadState(ctx.cwd, taskId);
					if (!state) {
						ctx.ui.notify(`No forge found for ${taskId}.`, "error");
						return;
					}
					if (state.status === "completed") {
						ctx.ui.notify(
							`Forge for ${taskId} is already completed.`,
							"warning",
						);
						return;
					}

					if (activeTaskId && activeTaskId !== taskId) {
						const current = loadState(ctx.cwd, activeTaskId);
						if (current && current.status === "active") {
							current.status = "paused";
							saveState(ctx.cwd, current);
						}
					}

					state.status = "active";
					saveState(ctx.cwd, state);
					activeTaskId = taskId;

					ctx.ui.notify(
						`Forge resumed: ${taskId} (${state.phase}, cycle ${state.cycle})`,
						"info",
					);

					// Fresh session, then run loop
					const result = await ctx.newSession();
					if (result.cancelled) {
						state.status = "paused";
						saveState(ctx.cwd, state);
						activeTaskId = undefined;
						restoreReviewTools();
						ctx.ui.notify("Session cancelled. Forge remains paused.", "warning");
						return;
					}

					await runForgeLoop(ctx, taskId);
					return;
				}

				case "status": {
					const forges = listForges(ctx.cwd);
					if (forges.length === 0) {
						ctx.ui.notify("No forges found.", "info");
						return;
					}
					const lines = forges.map((s) => {
						const icon = s.status === "active" ? ">" : s.status === "paused" ? "||" : "x";
						return `  ${icon} ${s.taskId}: ${s.status} (${s.phase}, cycle ${s.cycle})`;
					});
					ctx.ui.notify(`Forges:\n${lines.join("\n")}`, "info");
					return;
				}

				case "set": {
					// /forge set <task-id> <model> [<thinking>]
					const taskId = rest[0];
					const modelId = rest[1];
					const thinking = rest[2];

					const VALID_THINKING: ReadonlyArray<string> = ["minimal", "low", "medium", "high", "xhigh"];

					if (!taskId || !modelId) {
						ctx.ui.notify(
							"Usage: /forge set <task-id> <model> [<thinking>]",
							"warning",
						);
						return;
					}

					const model = resolveModel(ctx, modelId);
					if (!model) {
						ctx.ui.notify(`Model "${modelId}" not found.`, "error");
						return;
					}

					if (thinking && !VALID_THINKING.includes(thinking)) {
						ctx.ui.notify(
							`Invalid thinking level "${thinking}". Valid: ${VALID_THINKING.join(", ")}`,
							"error",
						);
						return;
					}

					let state = loadState(ctx.cwd, taskId);
					if (!state) {
						const item = await readBacklogItem(ctx.cwd, taskId);
						if (!item) {
							ctx.ui.notify(`Backlog item ${taskId} not found.`, "error");
							return;
						}
						state = {
							taskId,
							phase: "implementing",
							cycle: 1,
							status: "paused",
							reviewer: {},
							startedAt: new Date().toISOString(),
						};
					}

					state.reviewer = { model: modelId, ...(thinking ? { thinking } : {}) };
					saveState(ctx.cwd, state);

					const parts = [`model=${modelId}`];
					if (thinking) parts.push(`thinking=${thinking}`);
					ctx.ui.notify(
						`Forge ${taskId}: reviewer ${parts.join(", ")}`,
						"info",
					);
					return;
				}

				case "cancel": {
					const taskId = rest[0];
					if (!taskId) {
						ctx.ui.notify("Usage: /forge cancel <task-id>", "warning");
						return;
					}

					if (!loadState(ctx.cwd, taskId)) {
						ctx.ui.notify(`No forge found for ${taskId}.`, "error");
						return;
					}

					if (activeTaskId === taskId) {
						activeTaskId = undefined;
						restoreReviewTools();
					}

					deleteForge(ctx.cwd, taskId);
					updateUI(ctx.cwd, ctx);
					ctx.ui.notify(`Forge cancelled: ${taskId}`, "info");
					return;
				}

				default: {
					ctx.ui.notify(FORGE_HELP, "info");
					return;
				}
			}
		},
	});

	// ── Event handlers ───────────────────────────────────────────────

	// Resolve the forge loop's wait when the agent finishes
	pi.on("agent_end", async (event, _ctx) => {
		if (agentEndResolve) {
			const resolve = agentEndResolve;
			agentEndResolve = undefined;
			resolve(event as AgentEndEvent);
		}
	});

	// Inject phase-appropriate system prompt
	pi.on("before_agent_start", async (event, ctx) => {
		if (!activeTaskId) return;
		const state = loadState(ctx.cwd, activeTaskId);
		if (!state || state.status !== "active") return;

		const snippet =
			state.phase === "implementing"
				? implementSystemSnippet(state)
				: reviewSystemSnippet(state);

		return {
			systemPrompt: event.systemPrompt + "\n\n" + snippet,
		};
	});

	// Block backlog close during implementing + block non-finder/librarian agents during review
	pi.on("tool_call", async (event, ctx) => {
		if (!activeTaskId) return undefined;
		const state = loadState(ctx.cwd, activeTaskId);
		if (!state || state.status !== "active") return undefined;

		const input = (event as { input: Record<string, unknown> }).input;

		if (state.phase === "implementing" && event.toolName === "backlog") {
			const command = typeof input["command"] === "string" ? input["command"] : "";
			if (/^\s*close\s+/u.test(command)) {
				return {
					block: true,
					reason: "Cannot close backlog tasks during implementation. The reviewer handles that.",
				};
			}
		}

		if (state.phase === "reviewing" && event.toolName === "agent") {
			const action = typeof input["action"] === "string" ? input["action"] : "";
			const agent = typeof input["agent"] === "string" ? input["agent"] : "";
			// Block spawn/send for non-finder/librarian, and block wait on unknown agents
			if (action === "spawn" || action === "send") {
				if (agent !== "finder" && agent !== "librarian") {
					return {
						block: true,
						reason: `During forge review, only finder and librarian agents are allowed. Cannot ${action} ${agent}.`,
					};
				}
			}
			if (action === "wait") {
				return {
					block: true,
					reason: "During forge review, agent wait is not allowed. Use finder or librarian directly.",
				};
			}
		}

		return undefined;
	});

	// Notify about forges on session start
	pi.on("session_start", async (_event, ctx) => {
		restoreReviewTools();

		// If loop is running (activeTaskId set), the command handler drives everything -- skip notification
		if (activeTaskId) {
			updateUI(ctx.cwd, ctx);
			return;
		}

		const onDisk = listForges(ctx.cwd).filter((s) => s.status === "active" || s.status === "paused");
		if (onDisk.length > 0 && ctx.hasUI) {
			const lines = onDisk.map(
				(s) => `  ${s.taskId}: ${s.status} (${s.phase}, cycle ${s.cycle})`,
			);
			ctx.ui.notify(
				`Forges on disk:\n${lines.join("\n")}\n\nUse /forge resume <task-id> to continue`,
				"info",
			);
		}
	});

	// Save state on shutdown
	pi.on("session_shutdown", async (_event, ctx) => {
		if (activeTaskId) {
			const state = loadState(ctx.cwd, activeTaskId);
			if (state) saveState(ctx.cwd, state);
		}
	});
}
