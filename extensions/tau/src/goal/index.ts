import type {
	AgentEndEvent,
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { Effect } from "effect";

import { Goal, type GoalService } from "../services/goal.js";
import { defineDecodedTool, textToolResult } from "../shared/decoded-tool.js";
import { formatDuration } from "../shared/format-duration.js";
import { formatTokenCount } from "../shared/format-tokens.js";
import { GoalConflictError, GoalValidationError } from "./errors.js";
import { budgetLimitPrompt, continuationPrompt, goalSystemPrompt } from "./prompts.js";
import type { GoalSnapshot, GoalStatus } from "./schema.js";

type RunGoal = <A, E>(effect: Effect.Effect<A, E, Goal>) => Promise<A>;

const GOAL_CONTINUATION_MESSAGE_TYPE = "tau:goal-continuation";
const GOAL_BUDGET_MESSAGE_TYPE = "tau:goal-budget-limit";

type GoalToolDetails = {
	readonly snapshot: GoalSnapshot | null;
};

type CreateGoalParams = {
	readonly objective: string;
	readonly token_budget?: number;
};

type UpdateGoalParams = {
	readonly status: "complete";
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeNoParams(raw: unknown): Record<string, never> {
	if (!isRecord(raw)) {
		throw new Error("expected an object");
	}
	return {};
}

function decodeCreateGoalParams(raw: unknown): CreateGoalParams {
	if (!isRecord(raw)) {
		throw new Error("expected an object");
	}
	const objective = raw["objective"];
	if (typeof objective !== "string" || objective.trim().length === 0) {
		throw new Error("objective must be a non-empty string");
	}
	const tokenBudget = raw["token_budget"];
	if (tokenBudget === undefined) {
		return { objective };
	}
	if (typeof tokenBudget !== "number" || !Number.isInteger(tokenBudget) || tokenBudget <= 0) {
		throw new Error("token_budget must be a positive integer");
	}
	return { objective, token_budget: tokenBudget };
}

function decodeUpdateGoalParams(raw: unknown): UpdateGoalParams {
	if (!isRecord(raw)) {
		throw new Error("expected an object");
	}
	if (raw["status"] !== "complete") {
		throw new Error('status must be "complete"');
	}
	return { status: "complete" };
}

function sessionIdFromContext(ctx: Pick<ExtensionContext, "sessionManager">): string {
	return ctx.sessionManager.getSessionId();
}

function branchFromContext(
	ctx: Pick<ExtensionContext, "sessionManager">,
): ReadonlyArray<SessionEntry> {
	return ctx.sessionManager.getBranch();
}

function describeGoal(goal: GoalSnapshot | null): string {
	if (goal === null) {
		return "No active thread goal.";
	}
	const budget =
		goal.tokenBudget === null
			? "no budget"
			: `${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(goal.tokenBudget)} tokens`;
	const runtime = formatDuration(goal.timeUsedSeconds * 1_000);
	return [
		`Goal: ${goal.objective}`,
		`Status: ${goal.status}`,
		`Usage: ${budget}, ${runtime}`,
	].join("\n");
}

function describeGoalInline(goal: GoalSnapshot): string {
	const budget =
		goal.tokenBudget === null
			? formatTokenCount(goal.tokensUsed)
			: `${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(goal.tokenBudget)}`;
	return `goal ${goal.status} ${budget}`;
}

function shouldAutoContinue(
	goal: GoalSnapshot | null,
	ctx: ExtensionContext,
): goal is GoalSnapshot {
	return (
		goal !== null &&
		goal.status === "active" &&
		!goal.continuationSuppressed &&
		ctx.isIdle() &&
		!ctx.hasPendingMessages()
	);
}

function clearGoalUi(ctx: ExtensionContext): void {
	if (!ctx.hasUI) {
		return;
	}
	ctx.ui.setStatus("goal", undefined);
	ctx.ui.setWidget("goal", undefined);
}

function updateGoalUi(ctx: ExtensionContext, goal: GoalSnapshot | null): void {
	if (!ctx.hasUI) {
		return;
	}
	if (goal === null || goal.status === "complete") {
		clearGoalUi(ctx);
		return;
	}
	ctx.ui.setStatus("goal", describeGoalInline(goal));
	ctx.ui.setWidget("goal", [
		`Goal: ${goal.objective}`,
		`Status: ${goal.status}`,
		`Usage: ${formatTokenCount(goal.tokensUsed)} tokens`,
		`Time: ${formatDuration(goal.timeUsedSeconds * 1_000)}`,
	]);
}

function errorText(error: unknown): string {
	if (error instanceof GoalConflictError || error instanceof GoalValidationError) {
		return error.reason;
	}
	return error instanceof Error ? error.message : String(error);
}

function goalToolResult(
	text: string,
	snapshot: GoalSnapshot | null,
	options?: { readonly isError?: boolean },
) {
	return textToolResult<GoalToolDetails>(text, { snapshot }, options);
}

function parseGoalCommand(args: string): {
	readonly command: "show" | "clear" | "pause" | "resume" | "complete" | "set";
	readonly objective?: string;
	readonly tokenBudget?: number | null;
} {
	const trimmed = args.trim();
	if (trimmed.length === 0) {
		return { command: "show" };
	}
	const [first] = trimmed.split(/\s+/, 1);
	switch (first) {
		case "clear":
		case "pause":
		case "resume":
		case "complete":
			return { command: first };
		default:
			break;
	}

	const parts = trimmed.split(/\s+/);
	if (parts[0] === "--budget") {
		const rawBudget = parts[1];
		if (rawBudget === undefined) {
			throw new GoalConflictError({ reason: "Usage: /goal --budget <tokens> <objective>" });
		}
		const budget = Number.parseInt(rawBudget, 10);
		if (!Number.isInteger(budget) || budget <= 0 || String(budget) !== rawBudget) {
			throw new GoalConflictError({ reason: "budget must be a positive integer" });
		}
		const objective = parts.slice(2).join(" ").trim();
		if (objective.length === 0) {
			throw new GoalConflictError({ reason: "objective must be non-empty" });
		}
		return { command: "set", objective, tokenBudget: budget };
	}

	return { command: "set", objective: trimmed, tokenBudget: null };
}

async function withGoal<A>(
	runGoal: RunGoal,
	effect: (goal: GoalService) => Effect.Effect<A, unknown, never>,
): Promise<A> {
	return runGoal(
		Effect.gen(function* () {
			const goal = yield* Goal;
			return yield* effect(goal);
		}),
	);
}

async function rehydrateAndUpdate(
	runGoal: RunGoal,
	ctx: ExtensionContext,
): Promise<GoalSnapshot | null> {
	const snapshot = await withGoal(runGoal, (goal) =>
		goal.rehydrate(sessionIdFromContext(ctx), branchFromContext(ctx)),
	);
	updateGoalUi(ctx, snapshot);
	return snapshot;
}

export default function initGoal(pi: ExtensionAPI, runGoal: RunGoal): void {
	pi.registerTool(
		defineDecodedTool({
			name: "get_goal",
			label: "get goal",
			description: "Get the current thread goal, including status, budgets, and usage.",
			parameters: Type.Object({}),
			decodeParams: decodeNoParams,
			formatInvalidParamsResult: (message) =>
				goalToolResult(message, null, { isError: true }),
			execute: async (_params, { ctx }) => {
				const snapshot = await withGoal(runGoal, (goal) =>
					goal.get(sessionIdFromContext(ctx)),
				);
				return goalToolResult(describeGoal(snapshot), snapshot);
			},
			renderCall: (_args, theme) =>
				new Text(theme.fg("toolTitle", theme.bold("get_goal")), 0, 0),
			renderResult: (result, _options, theme) => {
				const item = result.content[0];
				const text = item?.type === "text" ? item.text : "";
				return new Text(theme.fg("muted", text), 0, 0);
			},
		}),
	);

	pi.registerTool(
		defineDecodedTool({
			name: "create_goal",
			label: "create goal",
			description:
				"Create a thread goal. Use only when the user explicitly asks to start or track a goal. Fails if a goal already exists.",
			promptGuidelines: [
				"Use create_goal only when the user explicitly requests a thread goal.",
				"Do not replace an existing goal with create_goal; report the existing goal instead.",
			],
			parameters: Type.Object({
				objective: Type.String({ description: "Concrete objective for this thread." }),
				token_budget: Type.Optional(
					Type.Integer({ description: "Optional positive token budget." }),
				),
			}),
			decodeParams: decodeCreateGoalParams,
			formatInvalidParamsResult: (message) =>
				goalToolResult(message, null, { isError: true }),
			formatExecuteErrorResult: (error) =>
				goalToolResult(errorText(error), null, { isError: true }),
			execute: async (params, { ctx }) => {
				const snapshot = await withGoal(runGoal, (goal) =>
					goal.create(
						sessionIdFromContext(ctx),
						params.objective,
						params.token_budget ?? null,
						{
							failIfExists: true,
						},
					),
				);
				updateGoalUi(ctx, snapshot);
				return goalToolResult(`Created thread goal.\n${describeGoal(snapshot)}`, snapshot);
			},
			renderCall: (_args, theme) =>
				new Text(theme.fg("toolTitle", theme.bold("create_goal")), 0, 0),
			renderResult: (result, _options, theme) => {
				const item = result.content[0];
				const text = item?.type === "text" ? item.text : "";
				return new Text(theme.fg("muted", text), 0, 0);
			},
		}),
	);

	pi.registerTool(
		defineDecodedTool({
			name: "update_goal",
			label: "update goal",
			description:
				"Mark the current thread goal complete. The only accepted status is complete.",
			promptGuidelines: [
				"Call update_goal with status complete only when the objective is actually achieved.",
				"Do not use update_goal to pause, resume, clear, or budget-limit a goal.",
			],
			parameters: Type.Object({
				status: Type.Literal("complete"),
			}),
			decodeParams: decodeUpdateGoalParams,
			formatInvalidParamsResult: (message) =>
				goalToolResult(message, null, { isError: true }),
			formatExecuteErrorResult: (error) =>
				goalToolResult(errorText(error), null, { isError: true }),
			execute: async (_params, { ctx }) => {
				const snapshot = await withGoal(runGoal, (goal) =>
					goal.setStatus(sessionIdFromContext(ctx), "complete"),
				);
				if (snapshot === null) {
					return goalToolResult("No thread goal is set.", snapshot, { isError: true });
				}
				updateGoalUi(ctx, snapshot);
				return goalToolResult(
					`Goal complete. Final usage: ${formatTokenCount(snapshot.tokensUsed)} tokens, ${formatDuration(snapshot.timeUsedSeconds * 1_000)}.`,
					snapshot,
				);
			},
			renderCall: (_args, theme) =>
				new Text(theme.fg("toolTitle", theme.bold("update_goal")), 0, 0),
			renderResult: (result, _options, theme) => {
				const item = result.content[0];
				const text = item?.type === "text" ? item.text : "";
				return new Text(theme.fg("muted", text), 0, 0);
			},
		}),
	);

	pi.registerCommand("goal", {
		description: "View or manage the current thread goal",
		handler: async (args, ctx) => {
			try {
				const parsed = parseGoalCommand(args);
				const sessionId = sessionIdFromContext(ctx);
				if (parsed.command === "show") {
					const snapshot = await rehydrateAndUpdate(runGoal, ctx);
					ctx.ui.notify(describeGoal(snapshot), "info");
					return;
				}
				if (parsed.command === "clear") {
					await withGoal(runGoal, (goal) => goal.clear(sessionId));
					clearGoalUi(ctx);
					ctx.ui.notify("Cleared thread goal.", "info");
					return;
				}
				if (
					parsed.command === "pause" ||
					parsed.command === "resume" ||
					parsed.command === "complete"
				) {
					const status: GoalStatus =
						parsed.command === "resume"
							? "active"
							: parsed.command === "pause"
								? "paused"
								: "complete";
					const snapshot = await withGoal(runGoal, (goal) =>
						goal.setStatus(sessionId, status),
					);
					updateGoalUi(ctx, snapshot);
					ctx.ui.notify(describeGoal(snapshot), "info");
					return;
				}

				const objective = parsed.objective ?? "";
				const existing = await withGoal(runGoal, (goal) => goal.get(sessionId));
				if (existing !== null) {
					const confirmed = await ctx.ui.confirm(
						"Replace thread goal?",
						`Current: ${existing.objective}\n\nNew: ${objective}`,
					);
					if (!confirmed) {
						return;
					}
				}
				const snapshot = await withGoal(runGoal, (goal) =>
					goal.create(sessionId, objective, parsed.tokenBudget ?? null),
				);
				updateGoalUi(ctx, snapshot);
				ctx.ui.notify(`Set thread goal.\n${describeGoal(snapshot)}`, "info");
			} catch (error) {
				ctx.ui.notify(errorText(error), "error");
			}
		},
	});

	const onSessionReady = async (_event: unknown, ctx: ExtensionContext) => {
		try {
			await rehydrateAndUpdate(runGoal, ctx);
		} catch (error) {
			ctx.ui.notify(errorText(error), "error");
		}
	};

	pi.on("session_start", onSessionReady);
	pi.on("session_switch", onSessionReady);
	pi.on("session_fork", onSessionReady);
	pi.on("session_tree", onSessionReady);

	pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx) => {
		const snapshot = await withGoal(runGoal, (goal) =>
			goal
				.markAgentStart(sessionIdFromContext(ctx), Date.now())
				.pipe(Effect.andThen(goal.get(sessionIdFromContext(ctx)))),
		);
		if (snapshot?.status !== "active" && snapshot?.status !== "budget_limited") {
			return;
		}
		return {
			systemPrompt: `${event.systemPrompt}\n\n${goalSystemPrompt(snapshot)}`,
		};
	});

	pi.on("agent_end", async (event: AgentEndEvent, ctx) => {
		const sessionId = sessionIdFromContext(ctx);
		const result = await withGoal(runGoal, (goal) =>
			goal.accountAgentEnd(sessionId, event, Date.now()),
		);
		updateGoalUi(ctx, result.snapshot);

		if (result.budgetLimitReached && result.snapshot !== null) {
			await withGoal(runGoal, (goal) => goal.markBudgetLimitPromptSent(sessionId));
			pi.sendMessage(
				{
					customType: GOAL_BUDGET_MESSAGE_TYPE,
					content: budgetLimitPrompt(result.snapshot),
					display: false,
					details: { objective: result.snapshot.objective },
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			return;
		}

		if (!shouldAutoContinue(result.snapshot, ctx)) {
			return;
		}
		await withGoal(runGoal, (goal) => goal.markContinuationDispatched(sessionId));
		pi.sendMessage(
			{
				customType: GOAL_CONTINUATION_MESSAGE_TYPE,
				content: continuationPrompt(result.snapshot),
				display: false,
				details: { objective: result.snapshot.objective },
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	});
}
