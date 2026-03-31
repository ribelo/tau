import type { ForgeState } from "./types.js";

const REVIEW_JSON_SCHEMA = `{
  "findings": [
    {
      "title": "<≤ 80 chars, imperative>",
      "body": "<valid Markdown explaining why this is a problem>",
      "confidence_score": <float 0.0-1.0>,
      "priority": <int 0-3>,
      "code_location": {
        "absolute_file_path": "<file path>",
        "line_range": { "start": <int>, "end": <int> }
      }
    }
  ],
  "overall_correctness": "patch is correct" | "patch is incorrect",
  "overall_explanation": "<1-3 sentence explanation>",
  "overall_confidence_score": <float 0.0-1.0>
}`;

function reviewFeedbackSection(state: ForgeState): string {
	if (!state.lastReview) {
		return "First implementation cycle.";
	}

	return [
		`## Review JSON (from cycle ${state.cycle - 1})`,
		"",
		"```json",
		JSON.stringify(state.lastReview, null, 2),
		"```",
	].join("\n");
}

/** Build the IMPLEMENT prompt injected into the agent's user message. */
export function buildImplementPrompt(
	state: ForgeState,
	taskTitle: string,
	taskDescription: string,
): string {
	const header =
		`FORGE: ${state.taskId} | Cycle ${state.cycle} | IMPLEMENT\n` +
		`---`;

	return [
		header,
		"",
		`## Task: ${taskTitle}`,
		"",
		taskDescription,
		"",
		reviewFeedbackSection(state),
		"",
		"---",
		"",
		"Work on the task above. Add progress notes via `backlog comment`.",
		"When your implementation pass is complete, stop normally. Forge will start review automatically after your turn ends.",
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
		"## Last Implementer Message",
		"",
		state.lastImplementerMessage ?? "(no implementer message captured)",
		"",
		"---",
		"",
		"Review the implementation work. Only finder and librarian agents are available.",
		"Use the backlog tool to inspect task status.",
		"",
		"Return ONLY a JSON object matching this schema. Do not wrap it in markdown fences. Do not add prose before or after the JSON.",
		"",
		"```json",
		REVIEW_JSON_SCHEMA,
		"```",
		"",
		"If there are no findings, return an empty findings array. If there are findings, include all blocking findings that the implementer must fix next.",
	].join("\n");
}

/** System prompt snippet appended during IMPLEMENTING phase. */
export function implementSystemSnippet(state: ForgeState): string {
	return [
		`[FORGE - ${state.taskId} - Cycle ${state.cycle} - IMPLEMENTING]`,
		"",
		`You are implementing backlog task ${state.taskId}.`,
		"When your implementation pass is done, end your turn normally.",
		"Forge will start a fresh review session automatically after your turn ends.",
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
		"Your final message must be raw JSON matching the review schema from the user prompt.",
		"If there are no findings, return an empty findings array.",
		"If there are findings, include every blocking finding the implementer must fix next.",
	].join("\n");
}
