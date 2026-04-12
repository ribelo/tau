import { describe, expect, it } from "vitest";

import { shouldDeferAutoresearchResumeUntilAfterCompaction } from "../src/autoresearch/auto-resume.js";

describe("autoresearch auto-resume compaction guard", () => {
	it("defers resume when context usage is inside the compaction reserve window", () => {
		expect(
			shouldDeferAutoresearchResumeUntilAfterCompaction({
				tokens: 120_000,
				contextWindow: 128_000,
				percent: 93.75,
			}),
		).toBe(true);
	});

	it("does not defer when context usage is comfortably below the threshold", () => {
		expect(
			shouldDeferAutoresearchResumeUntilAfterCompaction({
				tokens: 80_000,
				contextWindow: 128_000,
				percent: 62.5,
			}),
		).toBe(false);
	});

	it("does not defer when the current token count is unknown", () => {
		expect(
			shouldDeferAutoresearchResumeUntilAfterCompaction({
				tokens: null,
				contextWindow: 128_000,
				percent: null,
			}),
		).toBe(false);
	});

	it("still defers on small context windows when already past the compaction threshold", () => {
		expect(
			shouldDeferAutoresearchResumeUntilAfterCompaction({
				tokens: 6_000,
				contextWindow: 8_000,
				percent: 75,
			}),
		).toBe(true);
	});
});
