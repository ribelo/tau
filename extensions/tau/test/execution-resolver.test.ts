import { describe, expect, it } from "vitest";

import {
	resolveModeModelCandidates,
	resolvePromptSelectorMode,
} from "../src/services/execution-resolver.js";

describe("execution resolver", () => {
	it("defaults prompt selector mode to default", () => {
		const mode = resolvePromptSelectorMode(undefined);
		expect(mode).toBe("default");
	});

	it("returns assigned model first and preset model second when assignment differs", () => {
		const candidates = resolveModeModelCandidates(
			{
				selector: {
					mode: "deep",
				},
				policy: {
					tools: {
						kind: "inherit",
					},
				},
				modelsByMode: {
					deep: "openai-codex/gpt-5.4-mini",
				},
			},
			"deep",
			"openai-codex/gpt-5.4",
		);

		expect(candidates).toEqual([
			"openai-codex/gpt-5.4-mini",
			"openai-codex/gpt-5.4",
		]);
	});

	it("returns only preset model when no per-mode assignment exists", () => {
		const candidates = resolveModeModelCandidates(
			{
				selector: {
					mode: "smart",
				},
				policy: {
					tools: {
						kind: "inherit",
					},
				},
			},
			"smart",
			"anthropic/claude-opus-4-5",
		);

		expect(candidates).toEqual(["anthropic/claude-opus-4-5"]);
	});
});
