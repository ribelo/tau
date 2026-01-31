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
thinking: high
sandbox_fs: workspace-write
sandbox_net: allow-all
approval_policy: on-failure
approval_timeout: 45
---
You are the oracle.`;

		const def = parseAgentDefinition(content);
		expect(def.name).toBe("oracle");
		expect(def.description).toBe("The oracle agent");
		expect(def.model).toBe("claude-3-5-sonnet-latest");
		expect(def.thinking).toBe("high");
		expect(def.sandbox.filesystemMode).toBe("workspace-write");
		expect(def.sandbox.networkMode).toBe("allow-all");
		expect(def.sandbox.approvalPolicy).toBe("on-failure");
		expect(def.sandbox.approvalTimeoutSeconds).toBe(45);
		expect(def.systemPrompt).toBe("You are the oracle.");
	});

	it("should handle inherit model", () => {
		const content = `---
name: finder
description: Finder agent
model: inherit
thinking: medium
sandbox_fs: read-only
sandbox_net: deny
approval_policy: never
approval_timeout: 60
---
Find stuff.`;

		const def = parseAgentDefinition(content);
		expect(def.model).toBe("inherit");
	});

	it("should throw on missing thinking", () => {
		const content = `---
name: oracle
description: The oracle agent
model: inherit
sandbox_fs: workspace-write
sandbox_net: allow-all
approval_policy: on-failure
approval_timeout: 60
---
Prompt`;

		expect(() => parseAgentDefinition(content)).toThrow("'thinking' is required");
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
model: inherit
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
		});

		it("should return null if agent not found", () => {
			const def = loadAgentDefinition("non-existent", tempDir);
			expect(def).toBeNull();
		});
	});
});
