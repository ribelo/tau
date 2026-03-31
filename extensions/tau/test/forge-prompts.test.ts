import { describe, expect, it } from "vitest";
import type { ForgeState } from "../src/forge/types.js";
import {
	buildImplementPrompt,
	buildReviewPrompt,
	implementSystemSnippet,
	reviewSystemSnippet,
} from "../src/forge/prompts.js";

function makeState(overrides: Partial<ForgeState> = {}): ForgeState {
	return {
		taskId: "tau-xyz",
		phase: "implementing",
		cycle: 1,
		status: "active",
		reviewer: {},
		startedAt: new Date().toISOString(),
		...overrides,
	};
}

describe("forge prompts", () => {
	describe("buildImplementPrompt", () => {
		it("includes task ID, cycle, title, and description", () => {
			const state = makeState({ cycle: 3 });
			const prompt = buildImplementPrompt(state, "Fix auth", "Auth is broken.");
			expect(prompt).toContain("tau-xyz");
			expect(prompt).toContain("Cycle 3");
			expect(prompt).toContain("IMPLEMENT");
			expect(prompt).toContain("Fix auth");
			expect(prompt).toContain("Auth is broken.");
		});

		it("shows 'First implementation cycle' when no feedback", () => {
			const state = makeState();
			const prompt = buildImplementPrompt(state, "T", "D");
			expect(prompt).toContain("First implementation cycle");
		});

	it("includes review feedback when present", () => {
			const state = makeState({
				cycle: 2,
				lastReview: {
					findings: [
						{
							title: "Fix parser error handling",
							body: "Missing parser guard.",
							confidence_score: 0.9,
							priority: 1,
							code_location: {
								absolute_file_path: "/tmp/parser.ts",
								line_range: { start: 12, end: 14 },
							},
						},
					],
					overall_correctness: "patch is incorrect",
					overall_explanation: "Parser guard missing.",
					overall_confidence_score: 0.9,
				},
			});
			const prompt = buildImplementPrompt(state, "T", "D");
			expect(prompt).toContain("Fix parser error handling");
			expect(prompt).toContain("Review JSON");
		});

		it("instructs the implementer to end normally", () => {
			const prompt = buildImplementPrompt(makeState(), "T", "D");
			expect(prompt).toContain("stop normally");
			expect(prompt).toContain("Do NOT close");
		});
	});

	describe("buildReviewPrompt", () => {
		it("includes task ID, cycle, and REVIEW label", () => {
			const state = makeState({
				phase: "reviewing",
				cycle: 2,
				lastImplementerMessage: "Implemented the patch.",
			});
			const prompt = buildReviewPrompt(state, "Fix auth", "Auth is broken.");
			expect(prompt).toContain("tau-xyz");
			expect(prompt).toContain("Cycle 2");
			expect(prompt).toContain("REVIEW");
			expect(prompt).toContain("Implemented the patch.");
		});

		it("instructs the reviewer to return raw json", () => {
			const prompt = buildReviewPrompt(makeState(), "T", "D");
			expect(prompt).toContain("Return ONLY a JSON object");
			expect(prompt).toContain("findings");
			expect(prompt).toContain("overall_correctness");
		});
	});

	describe("system snippets", () => {
		it("implementSystemSnippet tells the implementer to end normally", () => {
			const snippet = implementSystemSnippet(makeState({ cycle: 5 }));
			expect(snippet).toContain("IMPLEMENTING");
			expect(snippet).toContain("tau-xyz");
			expect(snippet).toContain("Cycle 5");
			expect(snippet).toContain("end your turn normally");
			expect(snippet).toContain("Do NOT close");
		});

		it("reviewSystemSnippet mentions raw json and task ID", () => {
			const snippet = reviewSystemSnippet(makeState({ phase: "reviewing" }));
			expect(snippet).toContain("REVIEWING");
			expect(snippet).toContain("tau-xyz");
			expect(snippet).toContain("raw JSON");
			expect(snippet).toContain("empty findings array");
		});
	});
});
