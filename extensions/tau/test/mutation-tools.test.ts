import { describe, expect, it } from "vitest";

import {
	getLegacyMutationToolSelection,
	rewriteMutationToolNames,
	rewriteShellToolNames,
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
			rewriteMutationToolNames(["read", "exec_command", "edit", "write", "bd"], {
				useApplyPatch: true,
			}),
		).toEqual(["read", "exec_command", "apply_patch", "bd"]);
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
			rewriteMutationToolNames(["read", "exec_command", "bd"], {
				useApplyPatch: true,
			}),
		).toEqual(["read", "exec_command", "bd"]);
	});

	it("captures the active legacy mutation selection", () => {
		expect(getLegacyMutationToolSelection(["read", "write", "edit", "apply_patch"])).toEqual([
			"write",
			"edit",
		]);
	});

	it("replaces built-in bash with codex-style shell tools", () => {
		expect(rewriteShellToolNames(["read", "bash", "edit"])).toEqual([
			"read",
			"exec_command",
			"write_stdin",
			"edit",
		]);
	});

	it("keeps shell tool activation deduplicated", () => {
		expect(rewriteShellToolNames(["read", "bash", "exec_command", "write_stdin"])).toEqual([
			"read",
			"exec_command",
			"write_stdin",
		]);
	});
});
