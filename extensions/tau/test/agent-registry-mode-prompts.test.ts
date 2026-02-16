import { describe, expect, it } from "vitest";

import { AgentRegistry } from "../src/agent/agent-registry.js";
import {
	DEEP_MODE_SYSTEM_PROMPT,
	RUSH_MODE_SYSTEM_PROMPT,
	SMART_MODE_SYSTEM_PROMPT,
} from "../src/prompt/modes.js";

describe("agent-registry: mode agents", () => {
	it("virtual mode agents use the same mode prompt markdown as /mode", () => {
		const registry = AgentRegistry.load(process.cwd());

		const smart = registry.resolve("smart", "medium");
		const deep = registry.resolve("deep", "medium");
		const rush = registry.resolve("rush", "medium");

		expect(smart?.systemPrompt).toBe(SMART_MODE_SYSTEM_PROMPT);
		expect(deep?.systemPrompt).toBe(DEEP_MODE_SYSTEM_PROMPT);
		expect(rush?.systemPrompt).toBe(RUSH_MODE_SYSTEM_PROMPT);
	});
});
