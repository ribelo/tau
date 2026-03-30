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
				lastFeedback: "Missing error handling in parser",
			});
			const prompt = buildImplementPrompt(state, "T", "D");
			expect(prompt).toContain("Missing error handling in parser");
			expect(prompt).toContain("Review Feedback");
		});

		it("instructs to call forge_done", () => {
			const prompt = buildImplementPrompt(makeState(), "T", "D");
			expect(prompt).toContain("forge_done");
			expect(prompt).toContain("Do NOT close");
		});
	});

	describe("buildReviewPrompt", () => {
		it("includes task ID, cycle, and REVIEW label", () => {
			const state = makeState({ phase: "reviewing", cycle: 2 });
			const prompt = buildReviewPrompt(state, "Fix auth", "Auth is broken.");
			expect(prompt).toContain("tau-xyz");
			expect(prompt).toContain("Cycle 2");
			expect(prompt).toContain("REVIEW");
		});

		it("instructs to call forge_review", () => {
			const prompt = buildReviewPrompt(makeState(), "T", "D");
			expect(prompt).toContain("forge_review");
			expect(prompt).toContain("complete");
			expect(prompt).toContain("reject");
		});
	});

	describe("system snippets", () => {
		it("implementSystemSnippet mentions forge_done and task ID", () => {
			const snippet = implementSystemSnippet(makeState({ cycle: 5 }));
			expect(snippet).toContain("IMPLEMENTING");
			expect(snippet).toContain("tau-xyz");
			expect(snippet).toContain("Cycle 5");
			expect(snippet).toContain("forge_done");
			expect(snippet).toContain("Do NOT close");
		});

		it("reviewSystemSnippet mentions forge_review and task ID", () => {
			const snippet = reviewSystemSnippet(makeState({ phase: "reviewing" }));
			expect(snippet).toContain("REVIEWING");
			expect(snippet).toContain("tau-xyz");
			expect(snippet).toContain("forge_review");
			expect(snippet).toContain("complete");
			expect(snippet).toContain("reject");
		});
	});
});
