import { describe, expect, it } from "vitest";

import {
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
