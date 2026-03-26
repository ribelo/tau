import { afterEach, describe, expect, it, vi } from "vitest";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";

import { AgentRegistry } from "../src/agent/agent-registry.js";
import { resolvePromptModePresets } from "../src/prompt/modes.js";

describe("agent-registry: mode agents", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("virtual mode agents use the same mode prompt markdown as /mode", async () => {
		const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tau-home-"));
		vi.stubEnv("HOME", tempHome);

		try {
			const registry = await Effect.runPromise(AgentRegistry.load(process.cwd()));
			const presets = await Effect.runPromise(resolvePromptModePresets(process.cwd()));

			const smart = registry.resolve("smart", "medium");
			const deep = registry.resolve("deep", "medium");
			const rush = registry.resolve("rush", "medium");
			const defaultMode = registry.resolve("default", "medium");
			const expectedTools = [
				"read",
				"bash",
				"edit",
				"write",
				"agent",
				"bd",
				"web_search_exa",
				"crawling_exa",
				"get_code_context_exa",
			];

			expect(smart?.systemPrompt).toBe(presets.smart.systemPrompt);
			expect(deep?.systemPrompt).toBe(presets.deep.systemPrompt);
			expect(rush?.systemPrompt).toBe(presets.rush.systemPrompt);
			expect(defaultMode).toBeUndefined();
			expect(registry.has("default")).toBe(false);
			expect(registry.names()).not.toContain("default");
			expect(smart?.tools).toEqual(expectedTools);
			expect(deep?.tools).toEqual(expectedTools);
			expect(rush?.tools).toEqual(expectedTools);
		} finally {
			fs.rmSync(tempHome, { recursive: true, force: true });
		}
	});
});
