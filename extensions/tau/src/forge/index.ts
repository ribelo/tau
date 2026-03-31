import * as fs from "node:fs";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
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
import { resolveBacklogPaths } from "../backlog/contract.js";
import { parseMaterializedIssues } from "../backlog/materialize.js";
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

	/** Resolve callback for the current waitForAgentEnd promise, if any. */
	let agentEndResolve: (() => void) | undefined;

	/** Wait for the next agent_end event. Set up BEFORE sending a message. */
	function waitForAgentEnd(): Promise<void> {
		return new Promise<void>((resolve) => {
			agentEndResolve = resolve;
		});
	}

	// ── Tool activation helpers ──────────────────────────────────────

	const REVIEW_BLOCKED_TOOLS = ["edit", "write", "git_commit_with_user_approval"];

	function activateForgeTools(phase: "implementing" | "reviewing"): void {
		const current = pi.getActiveTools();
		const without = current.filter(
			(t) => t !== TOOL_FORGE_DONE && t !== TOOL_FORGE_REVIEW,
		);
		if (phase === "implementing") {
			pi.setActiveTools([...without, TOOL_FORGE_DONE]);
		} else {
			const reviewTools = without.filter((t) => !REVIEW_BLOCKED_TOOLS.includes(t));
			pi.setActiveTools([...reviewTools, TOOL_FORGE_REVIEW]);
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

	/** Apply reviewer model if configured. */
	async function applyReviewerModel(
		ctx: import("@mariozechner/pi-coding-agent").ExtensionContext,
		state: ForgeState,
	): Promise<void> {
		if (!state.reviewer.model) return;
		const reviewerModel = resolveModel(ctx, state.reviewer.model);
		if (!reviewerModel) return;
		await pi.setModel(reviewerModel);
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
				activateForgeTools("implementing");
				updateUI(ctx.cwd, ctx);

				const agentDone = waitForAgentEnd();
				pi.sendUserMessage(
					buildImplementPrompt(state, title, description),
				);
				await agentDone;

				// Check what happened
				const after = loadState(ctx.cwd, taskId);
				if (!after || after.status !== "active") break;

				if (after.phase !== "reviewing") {
					// Agent finished without calling forge_done -- pause
					after.status = "paused";
					saveState(ctx.cwd, after);
					activeTaskId = undefined;
					deactivateForgeTools();
					updateUI(ctx.cwd, ctx);
					ctx.ui.notify(
						"Implementation ended without forge_done. Forge paused. Use /forge resume to continue.",
						"warning",
					);
					break;
				}

				// Transition to review: fresh session
				const result = await ctx.newSession();
				if (result.cancelled) {
					after.status = "paused";
					saveState(ctx.cwd, after);
					activeTaskId = undefined;
					deactivateForgeTools();
					updateUI(ctx.cwd, ctx);
					ctx.ui.notify("Session cancelled. Forge paused.", "warning");
					break;
				}

				// Loop continues -- next iteration picks up reviewing phase
				continue;
			}

			if (state.phase === "reviewing") {
				await applyReviewerModel(ctx, state);
				activateForgeTools("reviewing");
				updateUI(ctx.cwd, ctx);

				const agentDone = waitForAgentEnd();
				pi.sendUserMessage(
					buildReviewPrompt(state, title, description),
				);
				await agentDone;

				// Check what happened
				const after = loadState(ctx.cwd, taskId);
				if (!after) break;

				if (after.status === "completed") {
					// Review approved, task closed
					activeTaskId = undefined;
					deactivateForgeTools();
					updateUI(ctx.cwd, ctx);
					ctx.ui.notify(
						`Forge complete: ${taskId} (${after.cycle} cycles)`,
						"info",
					);
					break;
				}

				if (after.status !== "active") break;

				if (after.phase !== "implementing") {
					// Reviewer finished without calling forge_review -- pause
					after.status = "paused";
					saveState(ctx.cwd, after);
					activeTaskId = undefined;
					deactivateForgeTools();
					updateUI(ctx.cwd, ctx);
					ctx.ui.notify(
						"Review ended without forge_review. Forge paused. Use /forge resume to continue.",
						"warning",
					);
					break;
				}

				// Transition to implement: fresh session
				const result = await ctx.newSession();
				if (result.cancelled) {
					after.status = "paused";
					saveState(ctx.cwd, after);
					activeTaskId = undefined;
					deactivateForgeTools();
					updateUI(ctx.cwd, ctx);
					ctx.ui.notify("Session cancelled. Forge paused.", "warning");
					break;
				}

				// Loop continues -- next iteration picks up implementing phase
				continue;
			}

			break; // unknown phase
		}
	}

	// ── Tools ────────────────────────────────────────────────────────

	pi.registerTool({
		name: TOOL_FORGE_DONE,
		label: "Forge Done",
		description:
			"Signal that this implementation pass is complete. Transitions forge to review phase.",
		promptSnippet:
			"Signal completion of the current forge implementation pass.",
		promptGuidelines: [
			"Call this when your implementation work for the current forge cycle is done.",
			"After calling this, STOP immediately. Do not continue working.",
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

			// Transition to reviewing -- the command handler loop detects this after waitForIdle
			state.phase = "reviewing";
			saveState(ctx.cwd, state);

			return {
				content: [
					{
						type: "text",
						text: `Implementation complete (cycle ${state.cycle}). STOP now.`,
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
			"Submit review verdict. 'complete' closes the task. 'reject' starts next implementation cycle.",
		promptSnippet:
			"Submit the review verdict for the current forge cycle.",
		promptGuidelines: [
			"Call with { verdict: 'complete' } when all requirements are met and subtasks are closed.",
			"Call with { verdict: 'reject', feedback: '...' } to describe what needs fixing.",
			"After calling this, STOP immediately. Do not continue working.",
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
				// Close the backlog item
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
								text: `Failed to close backlog item ${state.taskId}. Retry or close manually.`,
							},
						],
						details: {},
					};
				}

				state.status = "completed";
				state.completedAt = new Date().toISOString();
				saveState(ctx.cwd, state);

				return {
					content: [
						{
							type: "text",
							text: `Forge complete. Task ${state.taskId} closed after ${state.cycle} cycle(s). STOP now.`,
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
			saveState(ctx.cwd, state);

			return {
				content: [
					{
						type: "text",
						text: `Review rejected. Feedback saved for cycle ${state.cycle}. STOP now.`,
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
  /forge stop                           Pause active forge (press ESC first if agent is running)
  /forge resume <task-id>               Resume a paused forge
  /forge status                         Show all forges
  /forge set <task-id> reviewer model <id>  Set reviewer model
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
					deactivateForgeTools();
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

					const model = resolveModel(ctx, modelId);
					if (!model) {
						ctx.ui.notify(`Model "${modelId}" not found.`, "error");
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
	pi.on("agent_end", async (_event, _ctx) => {
		if (agentEndResolve) {
			const resolve = agentEndResolve;
			agentEndResolve = undefined;
			resolve();
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
		deactivateForgeTools();

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
