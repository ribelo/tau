import type { ForgeState } from "./types.js";

/** Build the IMPLEMENT prompt injected into the agent's user message. */
export function buildImplementPrompt(
	state: ForgeState,
	taskTitle: string,
	taskDescription: string,
): string {
	const header =
		`FORGE: ${state.taskId} | Cycle ${state.cycle} | IMPLEMENT\n` +
		`---`;

	const feedbackSection =
		state.lastFeedback
			? `## Review Feedback (from cycle ${state.cycle - 1})\n\n${state.lastFeedback}`
			: "First implementation cycle.";

	return [
		header,
		"",
		`## Task: ${taskTitle}`,
		"",
		taskDescription,
		"",
		feedbackSection,
		"",
		"---",
		"",
		"Work on the task above. Add progress notes via `backlog comment`.",
		"Call `forge_done` when this implementation pass is complete.",
		"After calling forge_done, STOP. Do not continue working. A fresh review session starts automatically.",
		"Do NOT close the backlog task directly.",
	].join("\n");
}

/** Build the REVIEW prompt injected at the start of the review session. */
export function buildReviewPrompt(
	state: ForgeState,
	taskTitle: string,
	taskDescription: string,
): string {
	const header =
		`FORGE: ${state.taskId} | Cycle ${state.cycle} | REVIEW\n` +
		`---`;

	return [
		header,
		"",
		`## Task: ${taskTitle}`,
		"",
		taskDescription,
		"",
		"---",
		"",
		"Review the implementation work. Only finder and librarian agents are available.",
		"Use the backlog tool to check task status. Close tasks that pass review.",
		"",
		"Call `forge_review` with your verdict:",
		"- `{ verdict: 'complete' }` -- all work passes review",
		"- `{ verdict: 'reject', feedback: '...' }` -- describe what needs fixing",
	].join("\n");
}

/** System prompt snippet appended during IMPLEMENTING phase. */
export function implementSystemSnippet(state: ForgeState): string {
	return [
		`[FORGE - ${state.taskId} - Cycle ${state.cycle} - IMPLEMENTING]`,
		"",
		`You are implementing backlog task ${state.taskId}.`,
		"When your implementation pass is done, call the forge_done tool.",
		"After calling forge_done, STOP immediately. Do not emit further output.",
		"A fresh review session starts automatically.",
		"Do NOT close the backlog task. The reviewer handles that.",
	].join("\n");
}

/** System prompt snippet appended during REVIEWING phase. */
export function reviewSystemSnippet(state: ForgeState): string {
	return [
		`[FORGE - ${state.taskId} - Cycle ${state.cycle} - REVIEWING]`,
		"",
		`You are reviewing implementation work on backlog task ${state.taskId}.`,
		"Only finder and librarian agents are available. Other agents are blocked.",
		"Close subtasks that pass review: `backlog close <subtask-id> --reason \"...\"`.",
		"Evaluate the work, then call forge_review with your verdict.",
		"- { verdict: 'complete' } when all work passes and all subtasks are closed",
		"- { verdict: 'reject', feedback: '...' } to request changes",
	].join("\n");
}
