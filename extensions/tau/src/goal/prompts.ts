import { formatDuration } from "../shared/format-duration.js";
import { formatTokenCount } from "../shared/format-tokens.js";
import type { GoalSnapshot } from "./schema.js";

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export function formatGoalUsage(goal: GoalSnapshot): string {
	const budget =
		goal.tokenBudget === null
			? "no token budget"
			: `${formatTokenCount(goal.tokenBudget)} budget`;
	return `${formatTokenCount(goal.tokensUsed)} tokens used, ${formatDuration(goal.timeUsedSeconds * 1_000)}, ${budget}`;
}

export function continuationPrompt(goal: GoalSnapshot): string {
	return `Continue working toward the active thread goal.

<goal>
${escapeXml(goal.objective)}
</goal>

Current goal status: ${goal.status}
Current goal usage: ${formatGoalUsage(goal)}

Before doing more work, briefly audit whether the goal is already complete.
If no required work remains, call update_goal with status "complete".
If work remains, continue with the next concrete step toward the goal.
Do not mark the goal complete merely because a budget is low or exhausted.`;
}

export function budgetLimitPrompt(goal: GoalSnapshot): string {
	return `The active thread goal has reached its token budget.

<goal>
${escapeXml(goal.objective)}
</goal>

Current goal usage: ${formatGoalUsage(goal)}

Do not start new substantive work.
Wrap up the current state concisely: what is complete, what remains, and any verification or blockers.
Call update_goal with status "complete" only if the objective is actually achieved.`;
}

export function goalSystemPrompt(goal: GoalSnapshot): string {
	if (goal.status === "budget_limited") {
		return `[THREAD GOAL - BUDGET LIMITED]

<goal>
${escapeXml(goal.objective)}
</goal>

Current goal usage: ${formatGoalUsage(goal)}
Do not start new substantive work toward this goal. Summarize or wrap up unless the user explicitly redirects.`;
	}

	return `[THREAD GOAL - ACTIVE]

<goal>
${escapeXml(goal.objective)}
</goal>

Current goal usage: ${formatGoalUsage(goal)}
Keep work aligned with this goal. Call update_goal with status "complete" only when the objective is actually achieved.`;
}
