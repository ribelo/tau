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
		"Do NOT close the backlog task directly.",
	].join("\n");
}

/** Build the REVIEW prompt injected into the same session after forge_done. */
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
		"Review the implementation work done in this session.",
		"Evaluate whether the task requirements are met.",
		"",
		"Call `forge_review` with your verdict:",
		"- `{ verdict: 'complete' }` -- task is done, close it",
		"- `{ verdict: 'reject', feedback: '...' }` -- describe what is wrong and what to fix",
	].join("\n");
}

/** System prompt snippet appended during IMPLEMENTING phase. */
export function implementSystemSnippet(state: ForgeState): string {
	return [
		`[FORGE - ${state.taskId} - Cycle ${state.cycle} - IMPLEMENTING]`,
		"",
		`You are implementing backlog task ${state.taskId}.`,
		"When your implementation pass is done, call the forge_done tool.",
		"Do NOT close the backlog task. The reviewer will handle that.",
	].join("\n");
}

/** System prompt snippet appended during REVIEWING phase. */
export function reviewSystemSnippet(state: ForgeState): string {
	return [
		`[FORGE - ${state.taskId} - Cycle ${state.cycle} - REVIEWING]`,
		"",
		`You are reviewing implementation work on backlog task ${state.taskId}.`,
		"Evaluate the work, then call forge_review with your verdict.",
		"- { verdict: 'complete' } to close the task",
		"- { verdict: 'reject', feedback: '...' } to request changes",
	].join("\n");
}
