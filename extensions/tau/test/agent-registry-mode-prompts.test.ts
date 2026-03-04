import { afterEach, describe, expect, it, vi } from "vitest";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { AgentRegistry } from "../src/agent/agent-registry.js";
import {
	DEEP_MODE_SYSTEM_PROMPT,
	RUSH_MODE_SYSTEM_PROMPT,
	SMART_MODE_SYSTEM_PROMPT,
} from "../src/prompt/modes.js";

describe("agent-registry: mode agents", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("virtual mode agents use the same mode prompt markdown as /mode", () => {
		const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tau-home-"));
		vi.stubEnv("HOME", tempHome);

		try {
			const registry = AgentRegistry.load(process.cwd());

			const smart = registry.resolve("smart", "medium");
			const deep = registry.resolve("deep", "medium");
			const rush = registry.resolve("rush", "medium");

			expect(smart?.systemPrompt).toBe(SMART_MODE_SYSTEM_PROMPT);
			expect(deep?.systemPrompt).toBe(DEEP_MODE_SYSTEM_PROMPT);
			expect(rush?.systemPrompt).toBe(RUSH_MODE_SYSTEM_PROMPT);
		} finally {
			fs.rmSync(tempHome, { recursive: true, force: true });
		}
	});
});
