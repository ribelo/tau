import { describe, expect, it } from "vitest";

import {
	buildDisabledAgentMessage,
	DEFAULT_WAIT_TIMEOUT_MS,
	MAX_WAIT_TIMEOUT_MS,
	normalizeWaitTimeoutMs,
} from "../src/agent/control.js";

describe("agent wait timeout normalization", () => {
	it("uses the default timeout when none is provided", () => {
		expect(normalizeWaitTimeoutMs(undefined)).toBe(DEFAULT_WAIT_TIMEOUT_MS);
	});

	it("rounds smaller requested timeouts up to the default", () => {
		expect(normalizeWaitTimeoutMs(120_000)).toBe(DEFAULT_WAIT_TIMEOUT_MS);
	});

	it("keeps larger requested timeouts up to the max", () => {
		expect(normalizeWaitTimeoutMs(1_800_000)).toBe(1_800_000);
	});

	it("caps requested timeouts at the maximum", () => {
		expect(normalizeWaitTimeoutMs(MAX_WAIT_TIMEOUT_MS + 1)).toBe(MAX_WAIT_TIMEOUT_MS);
	});
});

describe("disabled agent message", () => {
	it("does not instruct the assistant to use slash commands", () => {
		const message = buildDisabledAgentMessage("review", ["finder", "librarian"]);
		expect(message).toContain('Agent "review" is disabled for this session.');
		expect(message).toContain("Enabled agents: finder, librarian.");
		expect(message).toContain("ask the user to enable it for this session");
		expect(message).not.toContain("/agents");
	});

	it("renders an explicit none state when no agents are enabled", () => {
		const message = buildDisabledAgentMessage("review", []);
		expect(message).toContain("Enabled agents: (none).");
	});
});
