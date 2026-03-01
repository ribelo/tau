import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { parseAgentDefinition, loadAgentDefinition } from "../src/agent/parser.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("agent-parser", () => {
	it("should parse valid agent definition with models array", () => {
		const content = `---
name: oracle
description: The oracle agent
models:
  - model: claude-3-5-sonnet-latest
    thinking: high
  - model: groq/llama-4-scout
    thinking: medium
sandbox_fs: workspace-write
sandbox_net: allow-all
approval_policy: on-failure
approval_timeout: 45
---
You are the oracle.`;

		const def = parseAgentDefinition(content);
		expect(def.name).toBe("oracle");
		expect(def.description).toBe("The oracle agent");
		expect(def.models).toHaveLength(2);
		expect(def.models[0]).toEqual({ model: "claude-3-5-sonnet-latest", thinking: "high" });
		expect(def.models[1]).toEqual({ model: "groq/llama-4-scout", thinking: "medium" });
		expect(def.sandbox.filesystemMode).toBe("workspace-write");
		expect(def.sandbox.networkMode).toBe("allow-all");
		expect(def.sandbox.approvalPolicy).toBe("on-failure");
		expect(def.sandbox.approvalTimeoutSeconds).toBe(45);
		expect(def.systemPrompt).toBe("You are the oracle.");
	});

	it("should parse inherit model", () => {
		const content = `---
name: finder
description: Finder agent
models:
  - model: inherit
    thinking: inherit
sandbox_fs: read-only
sandbox_net: deny
approval_policy: never
approval_timeout: 60
---
Find stuff.`;

		const def = parseAgentDefinition(content);
		expect(def.models).toHaveLength(1);
		expect(def.models[0]).toEqual({ model: "inherit", thinking: "inherit" });
	});

	it("should parse models without thinking", () => {
		const content = `---
name: rush
description: Fast agent
models:
  - model: groq/llama-4-scout
  - model: anthropic/claude-haiku-4-5
sandbox_fs: workspace-write
sandbox_net: allow-all
approval_policy: never
approval_timeout: 60
---
Go fast.`;

		const def = parseAgentDefinition(content);
		expect(def.models).toHaveLength(2);
		expect(def.models[0]).toEqual({ model: "groq/llama-4-scout" });
		expect(def.models[1]).toEqual({ model: "anthropic/claude-haiku-4-5" });
	});

	it("should throw on missing models", () => {
		const content = `---
name: oracle
description: The oracle agent
sandbox_fs: workspace-write
sandbox_net: allow-all
approval_policy: on-failure
approval_timeout: 60
---
Prompt`;

		expect(() => parseAgentDefinition(content)).toThrow(/\["models"\]/);
	});

	it("should throw on empty models array", () => {
		const content = `---
name: oracle
description: The oracle agent
models: []
sandbox_fs: workspace-write
sandbox_net: allow-all
approval_policy: on-failure
approval_timeout: 60
---
Prompt`;

		expect(() => parseAgentDefinition(content)).toThrow(/\["models"\]/);
	});

	it("should throw on missing frontmatter", () => {
		const content = "No frontmatter here";
		expect(() => parseAgentDefinition(content)).toThrow("Missing YAML frontmatter");
	});

	it("should throw on invalid frontmatter", () => {
		const content = `---
invalid
---
Prompt`;
		expect(() => parseAgentDefinition(content)).toThrow();
	});

	it("should throw on missing required fields", () => {
		const content = `---
name: only-name
---
Prompt`;
		expect(() => parseAgentDefinition(content)).toThrow(/\["description"\]/);
	});

	describe("loadAgentDefinition", () => {
		const tempDir = path.join(os.tmpdir(), "tau-agent-test-" + Math.random().toString(36).slice(2));
		const agentsDir = path.join(tempDir, ".pi", "agents");

		beforeAll(() => {
			fs.mkdirSync(agentsDir, { recursive: true });
			fs.writeFileSync(path.join(agentsDir, "test-agent.md"), `---
name: test-agent
description: A test agent
models:
  - model: inherit
    thinking: low
sandbox_fs: read-only
sandbox_net: deny
approval_policy: never
approval_timeout: 60
---
Test prompt`);
		});

		afterAll(() => {
			fs.rmSync(tempDir, { recursive: true, force: true });
		});

		it("should load agent from project .pi/agents", () => {
			const def = loadAgentDefinition("test-agent", tempDir);
			expect(def).not.toBeNull();
			expect(def?.name).toBe("test-agent");
			expect(def?.description).toBe("A test agent");
			expect(def?.models).toHaveLength(1);
			expect(def?.models[0]).toEqual({ model: "inherit", thinking: "low" });
		});

		it("should return null if agent not found", () => {
			const def = loadAgentDefinition("non-existent", tempDir);
			expect(def).toBeNull();
		});
	});
});
