import { describe, expect, it } from "vitest";

import { shouldCloseAutoresearchOverlay } from "../src/autoresearch/overlay-input.js";

describe("autoresearch overlay input", () => {
	it("closes on explicit quit keys", () => {
		expect(shouldCloseAutoresearchOverlay("q")).toBe(true);
		expect(shouldCloseAutoresearchOverlay("Q")).toBe(true);
		expect(shouldCloseAutoresearchOverlay("\u001b")).toBe(true);
	});

	it("ignores normal navigation keys", () => {
		expect(shouldCloseAutoresearchOverlay("j")).toBe(false);
		expect(shouldCloseAutoresearchOverlay("k")).toBe(false);
		expect(shouldCloseAutoresearchOverlay("g")).toBe(false);
	});
});
