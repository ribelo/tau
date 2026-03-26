import { describe, expect, it } from "vitest";

import {
	getLegacyMutationToolSelection,
	rewriteMutationToolNames,
	shouldUseApplyPatchForProvider,
} from "../src/sandbox/mutation-tools.js";

describe("mutation tool routing", () => {
	it("uses apply_patch for openai-family providers", () => {
		expect(shouldUseApplyPatchForProvider("openai")).toBe(true);
		expect(shouldUseApplyPatchForProvider("openai-codex")).toBe(true);
		expect(shouldUseApplyPatchForProvider("anthropic")).toBe(false);
		expect(shouldUseApplyPatchForProvider(undefined)).toBe(false);
	});

	it("rewrites edit/write to apply_patch while preserving order", () => {
		expect(
			rewriteMutationToolNames(["read", "bash", "edit", "write", "bd"], {
				useApplyPatch: true,
			}),
		).toEqual(["read", "bash", "apply_patch", "bd"]);
	});

	it("restores the remembered legacy mutation selection", () => {
		expect(
			rewriteMutationToolNames(["read", "apply_patch", "bd"], {
				useApplyPatch: false,
				legacySelection: ["edit"],
			}),
		).toEqual(["read", "edit", "bd"]);
	});

	it("does not add mutation tools when none are active", () => {
		expect(
			rewriteMutationToolNames(["read", "bash", "bd"], {
				useApplyPatch: true,
			}),
		).toEqual(["read", "bash", "bd"]);
	});

	it("captures the active legacy mutation selection", () => {
		expect(getLegacyMutationToolSelection(["read", "write", "edit", "apply_patch"])).toEqual([
			"write",
			"edit",
		]);
	});
});
