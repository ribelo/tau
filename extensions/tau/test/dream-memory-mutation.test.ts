import { describe, expect, it } from "vitest";

import {
	didMemoryToolSucceed,
	readMemoryToolAction,
	shouldCountMemoryMutation,
} from "../src/dream/memory-mutations.js";

describe("dream memory mutation helpers", () => {
	it("reads the memory action from tool params", () => {
		expect(readMemoryToolAction({ action: "add" })).toBe("add");
		expect(readMemoryToolAction({ action: 123 })).toBeUndefined();
		expect(readMemoryToolAction(null)).toBeUndefined();
	});

	it("counts only successful mutation actions", () => {
		expect(
			shouldCountMemoryMutation("add", {
				details: { success: true },
			}),
		).toBe(true);

		expect(
			shouldCountMemoryMutation("add", {
				details: { success: false },
			}),
		).toBe(false);

		expect(
			shouldCountMemoryMutation("read", {
				details: { success: true },
			}),
		).toBe(false);

		expect(
			shouldCountMemoryMutation("remove", {
				isError: true,
				details: { success: true },
			}),
		).toBe(false);
	});

	it("detects successful memory results from tool details", () => {
		expect(didMemoryToolSucceed({ details: { success: true } })).toBe(true);
		expect(didMemoryToolSucceed({ details: { success: false } })).toBe(false);
		expect(didMemoryToolSucceed({ isError: true, details: { success: true } })).toBe(false);
	});
});
