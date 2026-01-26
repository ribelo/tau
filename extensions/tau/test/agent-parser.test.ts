import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { parseAgentDefinition, loadAgentDefinition } from "../src/agent/parser.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("agent-parser", () => {
	it("should parse valid agent definition", () => {
		const content = `---
name: oracle
description: The oracle agent
model: claude-3-5-sonnet-latest
thinking: 1000
sandbox_policy: workspace-write
approval_policy: on-failure
---
You are the oracle.`;

		const def = parseAgentDefinition(content);
		expect(def.name).toBe("oracle");
		expect(def.description).toBe("The oracle agent");
		expect(def.model).toBe("claude-3-5-sonnet-latest");
		expect(def.thinking).toBe(1000);
		expect(def.sandbox.filesystemMode).toBe("workspace-write");
		expect(def.sandbox.approvalPolicy).toBe("on-failure");
		expect(def.systemPrompt).toBe("You are the oracle.");
	});

	it("should handle inherit model", () => {
		const content = `---
name: finder
description: Finder agent
model: inherit
sandbox_policy: read-only
---
Find stuff.`;

		const def = parseAgentDefinition(content);
		expect(def.model).toBe("inherit");
	});

	it("should use reasoning_effort as fallback for thinking", () => {
		const content = `---
name: oracle
description: The oracle agent
reasoning_effort: high
sandbox_policy: workspace-write
---
Prompt`;

		const def = parseAgentDefinition(content);
		expect(def.thinking).toBe("high");
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
		expect(() => parseAgentDefinition(content)).toThrow("'description' is required");
	});

	describe("loadAgentDefinition", () => {
		const tempDir = path.join(os.tmpdir(), "tau-agent-test-" + Math.random().toString(36).slice(2));
		const agentsDir = path.join(tempDir, ".pi", "agents");

		beforeAll(() => {
			fs.mkdirSync(agentsDir, { recursive: true });
			fs.writeFileSync(path.join(agentsDir, "test-agent.md"), `---
name: test-agent
description: A test agent
sandbox_policy: read-only
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
		});

		it("should return null if agent not found", () => {
			const def = loadAgentDefinition("non-existent", tempDir);
			expect(def).toBeNull();
		});
	});
});
