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

	/** Captured newSession from command context for automatic session transitions. */
	let capturedNewSession: ExtensionCommandContext["newSession"] | undefined;

	/** Set after forge_done / forge_review(reject). Cleared by turn_end handler. */
	let pendingNewSession = false;

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

	// ── Tools ────────────────────────────────────────────────────────

	pi.registerTool({
		name: TOOL_FORGE_DONE,
		label: "Forge Done",
		description:
			"Signal that this implementation pass is complete. Transitions forge to review phase in a fresh session.",
		promptSnippet:
			"Signal completion of the current forge implementation pass to start the review phase.",
		promptGuidelines: [
			"Call this when your implementation work for the current forge cycle is done.",
			"After calling this, STOP. Do not continue working. A fresh review session starts automatically.",
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

			// Deactivate tools -- session_start in the new session will activate the right ones
			deactivateForgeTools();

			// Signal turn_end handler to create fresh session
			pendingNewSession = true;

			return {
				content: [
					{
						type: "text",
						text: `Implementation complete (cycle ${state.cycle}). Fresh review session starting.`,
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
			"Submit review verdict. 'complete' closes the task. 'reject' starts a fresh implementation cycle.",
		promptSnippet:
			"Submit the review verdict for the current forge cycle.",
		promptGuidelines: [
			"Call with { verdict: 'complete' } when the implementation meets all requirements and all subtasks are closed.",
			"Call with { verdict: 'reject', feedback: '...' } to describe what needs fixing.",
			"After calling this, STOP. Do not continue working.",
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
			saveState(ctx.cwd, state);

			// Deactivate tools -- session_start in the new session will activate the right ones
			deactivateForgeTools();

			// Signal turn_end handler to create fresh session
			pendingNewSession = true;

			return {
				content: [
					{
						type: "text",
						text: `Review rejected. Feedback saved for cycle ${state.cycle}. Fresh implementation session starting.`,
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
			const tokens = prefix.trimStart().split(/\s+/);
			// First token: subcommand
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

			// Second token: task-id for commands that need one
			if (tokens.length === 2) {
				if (sub === "start") {
					// Suggest open backlog items (sync read of cache file)
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
					// Suggest paused forges
					const forges = listForges(process.cwd()).filter((s) => s.status === "paused");
					return forges
						.filter((s) => s.taskId.startsWith(partial))
						.map((s) => ({ label: s.taskId, value: `${sub} ${s.taskId}`, description: `paused, cycle ${s.cycle}` }));
				}
				if (sub === "set" || sub === "cancel") {
					// Suggest existing forges first, then open backlog items for set
					const forges = listForges(process.cwd());
					const forgeItems = forges
						.filter((s) => s.taskId.startsWith(partial))
						.map((s) => ({ label: s.taskId, value: `${sub} ${s.taskId}`, description: `${s.status}, cycle ${s.cycle}` }));
					if (forgeItems.length > 0) return forgeItems;
					// For set: fall through to backlog items so user can pre-configure
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
			// Capture newSession for automatic transitions in forge_done / forge_review
			capturedNewSession = ctx.newSession.bind(ctx);

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

					// If pre-configured via /forge set, reuse that state
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
					pendingNewSession = false;
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

					ctx.ui.notify(
						`Forge resumed: ${taskId} (${state.phase}, cycle ${state.cycle})`,
						"info",
					);

					// Create fresh session -- session_start handler injects prompt + tools + model
					const result = await ctx.newSession();
					if (result.cancelled) {
						state.status = "paused";
						saveState(ctx.cwd, state);
						activeTaskId = undefined;
						deactivateForgeTools();
						updateUI(ctx);
						ctx.ui.notify("New session cancelled. Forge remains paused.", "warning");
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

					// Create a paused forge if none exists yet (pre-configuration)
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
						pendingNewSession = false;
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

	// Block implementer from closing the forge backlog task + block non-finder/librarian agents during review
	pi.on("tool_call", async (event, _ctx) => {
		if (!activeTaskId) return undefined;
		const state = loadState(process.cwd(), activeTaskId);
		if (!state || state.status !== "active") return undefined;

		const input = (event as { input: Record<string, unknown> }).input;

		// During implementing: block closing the forge task
		if (state.phase === "implementing" && event.toolName === "backlog") {
			const command = typeof input["command"] === "string" ? input["command"] : "";
			const closePattern = new RegExp(`^\\s*close\\s+${state.taskId}(\\s|$)`);
			if (closePattern.test(command)) {
				return {
					block: true,
					reason: `Cannot close forge task ${state.taskId} during implementation. Call forge_done instead.`,
				};
			}
		}

		// During reviewing: block agent spawn/send for non-finder/librarian
		if (state.phase === "reviewing" && event.toolName === "agent") {
			const action = typeof input["action"] === "string" ? input["action"] : "";
			const agent = typeof input["agent"] === "string" ? input["agent"] : "";
			if (
				(action === "spawn" || action === "send") &&
				agent !== "finder" &&
				agent !== "librarian"
			) {
				return {
					block: true,
					reason: `During forge review, only finder and librarian agents are allowed. Cannot ${action} ${agent}.`,
				};
			}
		}

		return undefined;
	});

	// After forge_done / forge_review(reject), create a fresh session
	pi.on("turn_end", async (_event, _ctx) => {
		if (!pendingNewSession) return;
		pendingNewSession = false;

		if (!capturedNewSession) return;
		const newSession = capturedNewSession;

		// Defer to next tick so the turn_end event processing completes first
		setTimeout(async () => {
			try {
				await newSession();
				// session_start handler will detect the active forge and inject prompt + tools + model
			} catch {
				// Failed to create session; forge state is saved, user can /forge resume
			}
		}, 0);
	});

	// On session start: if active forge, inject prompt + tools + model
	pi.on("session_start", async (_event, ctx) => {
		// Default: no forge tools
		deactivateForgeTools();

		if (activeTaskId) {
			const state = loadState(process.cwd(), activeTaskId);
			if (state?.status === "active") {
				activateForgeTools(state.phase);
				updateUI(ctx);

				// Apply reviewer model for review sessions
				if (state.phase === "reviewing") {
					await applyReviewerModel(ctx, state);
				}

				// Read task info and inject prompt
				const item = await readBacklogItem(ctx.cwd, state.taskId);
				const title = item?.title ?? state.taskId;
				const description = item?.description ?? "(no description)";

				if (state.phase === "implementing") {
					pi.sendUserMessage(
						buildImplementPrompt(state, title, description),
					);
				} else {
					pi.sendUserMessage(
						buildReviewPrompt(state, title, description),
					);
				}
				return;
			}
		}

		// No active runtime forge -- notify about on-disk forges from previous runs
		const onDisk = listForges(process.cwd()).filter((s) => s.status === "active" || s.status === "paused");
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
	pi.on("session_shutdown", async (_event, _ctx) => {
		if (activeTaskId) {
			const state = loadState(process.cwd(), activeTaskId);
			if (state) saveState(process.cwd(), state);
		}
	});
}
