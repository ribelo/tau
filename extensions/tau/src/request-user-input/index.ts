import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const QuestionOption = Type.Object({
	label: Type.String({ description: "User-facing label (1-5 words)." }),
	description: Type.String({
		description: "One short sentence explaining impact/tradeoff if selected.",
	}),
});

const Question = Type.Object({
	id: Type.String({
		description: "Stable identifier for mapping answers (snake_case).",
	}),
	header: Type.String({
		description: "Short header label shown in the UI (12 or fewer chars).",
	}),
	question: Type.String({
		description: "Single-sentence prompt shown to the user.",
	}),
	options: Type.Array(QuestionOption, {
		description:
			'Provide 2-4 mutually exclusive choices. Put the recommended option first and suffix its label with "(Recommended)". An "Other" free-form option is added automatically.',
	}),
});

const RequestUserInputParams = Type.Object({
	questions: Type.Array(Question, {
		description: "Questions to show the user. Prefer 1 and do not exceed 3.",
	}),
});

export default function initRequestUserInput(pi: ExtensionAPI) {
	pi.registerTool({
		name: "request_user_input",
		label: "request_user_input",
		description:
			"Request user input for one to three short questions with multiple-choice options and wait for the response. Available in plan mode. Use for decisions that materially change the plan, for confirming important assumptions, or for information that cannot be discovered via non-mutating exploration.",
		promptSnippet:
			"request_user_input: Present structured multiple-choice questions to the user. Use in plan mode for decisions/tradeoffs.",
		parameters: RequestUserInputParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [
						{
							type: "text" as const,
							text: "request_user_input is unavailable without a UI.",
						},
					],
					details: undefined,
				};
			}

			const answers: Record<string, string> = {};

			for (const question of params.questions) {
				if (signal?.aborted) {
					return {
						content: [
							{
								type: "text" as const,
								text: "request_user_input was cancelled.",
							},
						],
						details: undefined,
					};
				}

				const optionLabels = question.options.map((o) => o.label);
				optionLabels.push("Other (free-form)");

				const choice = await ctx.ui.select(
					`${question.header}: ${question.question}`,
					optionLabels,
					signal ? { signal } : undefined,
				);

				if (choice === undefined) {
					return {
						content: [
							{
								type: "text" as const,
								text: "request_user_input was cancelled before receiving a response.",
							},
						],
						details: undefined,
					};
				}

				if (choice === "Other (free-form)") {
					const freeForm = await ctx.ui.input(
						`${question.header}: ${question.question}`,
						"Type your answer...",
						signal ? { signal } : undefined,
					);
					answers[question.id] = freeForm ?? "(no response)";
				} else {
					answers[question.id] = choice;
				}
			}

			const result = JSON.stringify({ answers }, null, 2);
			return {
				content: [{ type: "text" as const, text: result }],
				details: answers,
			};
		},
	});
}
