import { describe, expect, it } from "vitest";

import {
	normalizeExecutionState,
} from "../src/execution/schema.js";

describe("execution normalization", () => {
	it("normalizes explicit execution state", () => {
		const state = normalizeExecutionState({
			selector: {
				mode: "smart",
			},
			modelsByMode: {
				smart: "openai-codex/gpt-5.4",
			},
		});

		expect(state.selector.mode).toBe("smart");
		expect(state.modelsByMode?.smart).toBe("openai-codex/gpt-5.4");
	});

	it("defaults missing selector/policy deterministically", () => {
		const state = normalizeExecutionState({});

		expect(state.selector.mode).toBe("default");
		expect(state.policy.tools.kind).toBe("inherit");
	});
});
