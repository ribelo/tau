import type {
	ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import type { ForgeState } from "./types.js";
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
import { setIssueStatus } from "../backlog/events.js";

const TOOL_FORGE_DONE = "forge_done";
const TOOL_FORGE_REVIEW = "forge_review";

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

/** Resolve a model object from a model ID string via the model registry. */
function resolveModel(
	ctx: { modelRegistry: import("@mariozechner/pi-coding-agent").ModelRegistry },
	modelId: string,
): import("@mariozechner/pi-ai").Model<import("@mariozechner/pi-ai").Api> | undefined {
	return ctx.modelRegistry.getAll().find((m) => m.id === modelId);
}

export default function initForge(pi: ExtensionAPI): void {
	/** The task ID of the currently active forge in this session, if any. */
	let activeTaskId: string | undefined;

	// ── Tool activation helpers ──────────────────────────────────────

	function activateForgeTools(phase: "implementing" | "reviewing"): void {
		const current = pi.getActiveTools();
		const without = current.filter(
			(t) => t !== TOOL_FORGE_DONE && t !== TOOL_FORGE_REVIEW,
		);
		if (phase === "implementing") {
			pi.setActiveTools([...without, TOOL_FORGE_DONE]);
		} else {
			pi.setActiveTools([...without, TOOL_FORGE_REVIEW]);
		}
	}

	function deactivateForgeTools(): void {
		const current = pi.getActiveTools();
		pi.setActiveTools(
			current.filter(
				(t) => t !== TOOL_FORGE_DONE && t !== TOOL_FORGE_REVIEW,
			),
		);
	}

	// ── UI helpers ───────────────────────────────────────────────────

	function updateUI(
		ctx: { hasUI: boolean; ui: import("@mariozechner/pi-coding-agent").ExtensionUIContext },
	): void {
		if (!ctx.hasUI) return;

		if (!activeTaskId) {
			ctx.ui.setStatus("forge", undefined);
			ctx.ui.setWidget("forge", undefined);
			return;
		}

		const state = loadState(process.cwd(), activeTaskId);
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

	/** The model that was active before the reviewer model was applied. */
	let implementerModel: import("@mariozechner/pi-ai").Model<import("@mariozechner/pi-ai").Api> | undefined;

	/** Apply reviewer model if configured. Saves current model for later restore. */
	async function applyReviewerModel(
		ctx: import("@mariozechner/pi-coding-agent").ExtensionContext,
		state: ForgeState,
	): Promise<void> {
		if (!state.reviewer.model) return;
		const reviewerModel = resolveModel(ctx, state.reviewer.model);
		if (!reviewerModel) return;
		implementerModel = ctx.model;
		const ok = await pi.setModel(reviewerModel);
		if (!ok) {
			// Model switch failed (e.g. no API key); clear saved model so we don't restore garbage
			implementerModel = undefined;
		}
	}

	/** Restore the implementer model after review phase. */
	async function restoreImplementerModel(): Promise<void> {
		if (implementerModel) {
			await pi.setModel(implementerModel);
			implementerModel = undefined;
		}
	}

	// ── Tools ────────────────────────────────────────────────────────

	pi.registerTool({
		name: TOOL_FORGE_DONE,
		label: "Forge Done",
		description:
			"Signal that this implementation pass is complete. Transitions forge to review phase.",
		promptSnippet:
			"Signal completion of the current forge implementation pass to start the review phase.",
		promptGuidelines: [
			"Call this when your implementation work for the current forge cycle is done.",
			"Do not call this outside an active forge IMPLEMENTING phase.",
		],
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!activeTaskId) {
				return {
					content: [{ type: "text", text: "No active forge." }],
					details: {},
				};
			}

			const state = loadState(ctx.cwd, activeTaskId);
			if (!state || state.status !== "active" || state.phase !== "implementing") {
				return {
					content: [
						{ type: "text", text: "Forge is not in IMPLEMENTING phase." },
					],
					details: {},
				};
			}

			// Transition to reviewing
			state.phase = "reviewing";
			saveState(ctx.cwd, state);
			activateForgeTools("reviewing");
			updateUI(ctx);

			// Apply reviewer model if configured
			await applyReviewerModel(ctx, state);

			// Read backlog item for review prompt
			const item = await readBacklogItem(ctx.cwd, state.taskId);
			const title = item?.title ?? state.taskId;
			const description = item?.description ?? "(no description)";

			// Inject review prompt into same session
			pi.sendUserMessage(buildReviewPrompt(state, title, description), {
				deliverAs: "followUp",
			});

			return {
				content: [
					{
						type: "text",
						text: `Implementation pass complete. Transitioning to review phase (cycle ${state.cycle}).`,
					},
				],
				details: {},
			};
		},

		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("forge_done")), 0, 0);
		},

		renderResult(result, _options, theme) {
			const msg = result.content[0];
			const text = msg?.type === "text" ? msg.text : "";
			return new Text(theme.fg("muted", text), 0, 0);
		},
	});

	pi.registerTool({
		name: TOOL_FORGE_REVIEW,
		label: "Forge Review",
		description:
			"Submit review verdict. 'complete' closes the task. 'reject' sends feedback for next implementation cycle.",
		promptSnippet:
			"Submit the review verdict for the current forge cycle.",
		promptGuidelines: [
			"Call with { verdict: 'complete' } when the implementation meets all requirements.",
			"Call with { verdict: 'reject', feedback: '...' } to describe what needs fixing.",
		],
		parameters: Type.Union([
			Type.Object({
				verdict: Type.Literal("complete"),
			}),
			Type.Object({
				verdict: Type.Literal("reject"),
				feedback: Type.String({
					description: "What is wrong and what to fix in the next cycle",
				}),
			}),
		]),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!activeTaskId) {
				return {
					content: [{ type: "text", text: "No active forge." }],
					details: {},
				};
			}

			const state = loadState(ctx.cwd, activeTaskId);
			if (!state || state.status !== "active" || state.phase !== "reviewing") {
				return {
					content: [
						{ type: "text", text: "Forge is not in REVIEWING phase." },
					],
					details: {},
				};
			}

			const verdict = (params as { verdict: string }).verdict;

			if (verdict === "complete") {
				// Close the backlog item via internal API
				const closed = await closeBacklogItem(
					ctx.cwd,
					state.taskId,
					"Forge review: complete",
				);

				if (!closed) {
					return {
						content: [
							{
								type: "text",
								text: `Failed to close backlog item ${state.taskId}. Forge state unchanged. Retry or close manually.`,
							},
						],
						details: {},
					};
				}

				state.status = "completed";
				state.completedAt = new Date().toISOString();
				saveState(ctx.cwd, state);

				const prevTaskId = activeTaskId;
				activeTaskId = undefined;
				deactivateForgeTools();
				updateUI(ctx);

				// Restore implementer model if reviewer model was applied
				await restoreImplementerModel();

				return {
					content: [
						{
							type: "text",
							text: `Forge complete. Task ${prevTaskId} closed after ${state.cycle} cycle(s).`,
						},
					],
					details: {},
				};
			}

			// verdict === "reject"
			const feedback = (params as { verdict: "reject"; feedback: string }).feedback;
			state.lastFeedback = feedback;
			state.cycle++;
			state.phase = "implementing";
			// Pause so /forge resume starts a fresh session via ctx.newSession()
			state.status = "paused";
			saveState(ctx.cwd, state);

			const taskId = activeTaskId;
			activeTaskId = undefined;
			deactivateForgeTools();
			updateUI(ctx);

			// Restore implementer model before next cycle
			await restoreImplementerModel();

			return {
				content: [
					{
						type: "text",
						text: `Review rejected. Feedback saved for cycle ${state.cycle}. Run /forge resume ${taskId} to start fresh session.`,
					},
				],
				details: {},
			};
		},

		renderCall(args, theme) {
			const verdict = (args as { verdict?: string }).verdict ?? "?";
			let text = theme.fg("toolTitle", theme.bold("forge_review "));
			text += verdict === "complete"
				? theme.fg("accent", "COMPLETE")
				: theme.fg("warning", "REJECT");
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const msg = result.content[0];
			const text = msg?.type === "text" ? msg.text : "";
			return new Text(theme.fg("muted", text), 0, 0);
		},
	});

	// ── Commands ─────────────────────────────────────────────────────

	const FORGE_HELP = `Forge -- implement-review loop on backlog items

Commands:
  /forge start <task-id>                Start forge loop on a backlog task
  /forge stop                           Pause active forge
  /forge resume <task-id>               Resume a paused forge
  /forge status                         Show all forges
  /forge set <task-id> reviewer model <id>  Set reviewer model
  /forge cancel <task-id>               Delete forge state`;

	pi.registerCommand("forge", {
		description: "Forge -- implement-review loop on backlog items",
		getArgumentCompletions(prefix: string) {
			const subs = ["start", "stop", "resume", "status", "set", "cancel"];
			const matching = subs.filter((s) => s.startsWith(prefix));
			return matching.map((s) => ({ label: s, value: s }));
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

					// Check if there's already an active forge
					const existing = findActiveForge(ctx.cwd);
					if (existing) {
						ctx.ui.notify(
							`Forge already active on ${existing.taskId}. Stop it first with /forge stop.`,
							"warning",
						);
						return;
					}

					// Check if this task already has a forge
					const prev = loadState(ctx.cwd, taskId);
					if (prev?.status === "active") {
						ctx.ui.notify(
							`Forge already active on ${taskId}. Use /forge resume ${taskId}.`,
							"warning",
						);
						return;
					}

					// Validate backlog item exists
					const item = await readBacklogItem(ctx.cwd, taskId);
					if (!item) {
						ctx.ui.notify(`Backlog item ${taskId} not found.`, "error");
						return;
					}

					const state: ForgeState = {
						taskId,
						phase: "implementing",
						cycle: 1,
						status: "active",
						reviewer: {},
						startedAt: new Date().toISOString(),
					};

					saveState(ctx.cwd, state);
					activeTaskId = taskId;
					activateForgeTools("implementing");
					updateUI(ctx);

					ctx.ui.notify(`Forge started on ${taskId} (cycle 1)`, "info");
					pi.sendUserMessage(
						buildImplementPrompt(state, item.title, item.description),
					);
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
					deactivateForgeTools();
					updateUI(ctx);
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
							`Forge for ${taskId} is already completed. Use /forge start ${taskId} to restart.`,
							"warning",
						);
						return;
					}

					// Pause any currently active forge
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
					activateForgeTools(state.phase);
					updateUI(ctx);

					const item = await readBacklogItem(ctx.cwd, taskId);
					const title = item?.title ?? taskId;
					const description = item?.description ?? "(no description)";

					ctx.ui.notify(
						`Forge resumed: ${taskId} (${state.phase}, cycle ${state.cycle})`,
						"info",
					);

					// Resume in a fresh session for implementing phase
					if (state.phase === "implementing") {
						const result = await ctx.newSession();
						if (result.cancelled) {
							// User cancelled new session; revert to paused
							state.status = "paused";
							saveState(ctx.cwd, state);
							activeTaskId = undefined;
							deactivateForgeTools();
							updateUI(ctx);
							ctx.ui.notify("New session cancelled. Forge remains paused.", "warning");
							return;
						}
						pi.sendUserMessage(
							buildImplementPrompt(state, title, description),
						);
					} else {
						// Reapply reviewer model when resuming in reviewing phase
						await applyReviewerModel(ctx, state);
						pi.sendUserMessage(
							buildReviewPrompt(state, title, description),
						);
					}
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
					// /forge set <task-id> reviewer model <model-id>
					const taskId = rest[0];
					const field = rest.slice(1).join(" ");
					if (!taskId || !field.startsWith("reviewer model ")) {
						ctx.ui.notify(
							"Usage: /forge set <task-id> reviewer model <model-id>",
							"warning",
						);
						return;
					}
					const modelId = field.slice("reviewer model ".length).trim();
					if (!modelId) {
						ctx.ui.notify("Missing model ID.", "warning");
						return;
					}

					// Validate model exists
					const model = resolveModel(ctx, modelId);
					if (!model) {
						ctx.ui.notify(`Model "${modelId}" not found.`, "error");
						return;
					}

					const state = loadState(ctx.cwd, taskId);
					if (!state) {
						ctx.ui.notify(`No forge found for ${taskId}.`, "error");
						return;
					}

					state.reviewer = { ...state.reviewer, model: modelId };
					saveState(ctx.cwd, state);
					ctx.ui.notify(
						`Forge ${taskId}: reviewer model set to ${modelId}`,
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
						deactivateForgeTools();
					}

					deleteForge(ctx.cwd, taskId);
					updateUI(ctx);
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

	// Inject phase-appropriate system prompt
	pi.on("before_agent_start", async (event, _ctx) => {
		if (!activeTaskId) return;
		const state = loadState(process.cwd(), activeTaskId);
		if (!state || state.status !== "active") return;

		const snippet =
			state.phase === "implementing"
				? implementSystemSnippet(state)
				: reviewSystemSnippet(state);

		return {
			systemPrompt: event.systemPrompt + "\n\n" + snippet,
		};
	});

	// Block implementer from closing the forge backlog task
	pi.on("tool_call", async (event, _ctx) => {
		if (!activeTaskId) return undefined;
		const state = loadState(process.cwd(), activeTaskId);
		if (!state || state.status !== "active" || state.phase !== "implementing") return undefined;

		// Only intercept backlog tool calls
		if (event.toolName !== "backlog") return undefined;
		const input = (event as { input: Record<string, unknown> }).input;
		const command = typeof input["command"] === "string" ? input["command"] : "";

		// Check if trying to close the forge task
		const closePattern = new RegExp(`^\\s*close\\s+${state.taskId}(\\s|$)`);
		if (closePattern.test(command)) {
			return {
				block: true,
				reason: `Cannot close forge task ${state.taskId} during implementation. Call forge_done instead.`,
			};
		}
		return undefined;
	});

	// Notify about active forges on session start
	pi.on("session_start", async (_event, ctx) => {
		// Deactivate forge tools by default; only activate if a forge is running
		deactivateForgeTools();

		const active = listForges(process.cwd()).filter((s) => s.status === "active");
		if (active.length > 0 && ctx.hasUI) {
			const lines = active.map(
				(s) => `  ${s.taskId}: ${s.phase}, cycle ${s.cycle}`,
			);
			ctx.ui.notify(
				`Active forges:\n${lines.join("\n")}\n\nUse /forge resume <task-id> to continue`,
				"info",
			);
		}

		// Restore tool activation if there's an active forge
		if (activeTaskId) {
			const state = loadState(process.cwd(), activeTaskId);
			if (state?.status === "active") {
				activateForgeTools(state.phase);
				updateUI(ctx);
			}
		}
	});

	// Save state on shutdown
	pi.on("session_shutdown", async (_event, _ctx) => {
		if (activeTaskId) {
			const state = loadState(process.cwd(), activeTaskId);
			if (state) saveState(process.cwd(), state);
		}
	});
}
