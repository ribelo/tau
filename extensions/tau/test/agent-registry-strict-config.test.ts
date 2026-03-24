import { afterEach, describe, expect, it, vi } from "vitest";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { AgentRegistry, AgentRegistryConfigError } from "../src/agent/agent-registry.js";

function mkdtemp(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf-8");
}

function validAgentMarkdown(name: string): string {
	return `---
name: ${name}
description: test agent
models:
  - model: inherit
    thinking: inherit
sandbox_fs: read-only
sandbox_net: allow-all
approval_policy: never
approval_timeout: 60
---

You are ${name}.
`;
}

describe("agent-registry strict validation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("fails when a discovered agent file is invalid", () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeFile(
			path.join(tempHome, ".pi", "agent", "agents", "oracle.md"),
			`---
name: oracle
description: broken
models:
  - model: inherit
    thinking: ultra
sandbox_fs: read-only
sandbox_net: allow-all
approval_policy: never
approval_timeout: 60
---

broken
`,
		);

		vi.stubEnv("HOME", tempHome);

		expect(() => AgentRegistry.load(tempProject)).toThrowError(AgentRegistryConfigError);
		expect(() => AgentRegistry.load(tempProject)).toThrow(/Invalid agent definition/);
		expect(() => AgentRegistry.load(tempProject)).toThrow(/oracle\.md/);

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("fails when user agent settings are malformed", () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeFile(
			path.join(tempHome, ".pi", "agent", "settings.json"),
			JSON.stringify(
				{
					agents: {
						oracle: {
							models: "not-an-array",
						},
					},
				},
				null,
				2,
			),
		);

		vi.stubEnv("HOME", tempHome);

		expect(() => AgentRegistry.load(tempProject)).toThrowError(AgentRegistryConfigError);
		expect(() => AgentRegistry.load(tempProject)).toThrow(
			/agents\.oracle\.models must be an array/,
		);

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("accepts xhigh in user agent settings", () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeFile(
			path.join(tempHome, ".pi", "agent", "agents", "oracle.md"),
			validAgentMarkdown("oracle"),
		);
		writeFile(
			path.join(tempHome, ".pi", "agent", "settings.json"),
			JSON.stringify(
				{
					agents: {
						oracle: {
							models: [
								{
									model: "openai-codex/gpt-5.3-codex",
									thinking: "xhigh",
								},
							],
						},
					},
				},
				null,
				2,
			),
		);

		vi.stubEnv("HOME", tempHome);

		const registry = AgentRegistry.load(tempProject);
		const resolved = registry.resolve("oracle", "medium");
		expect(resolved?.models[0]).toEqual({
			model: "openai-codex/gpt-5.3-codex",
			thinking: "xhigh",
		});

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("fails even when invalid lower-priority agent is overridden", () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeFile(
			path.join(tempHome, ".pi", "agent", "agents", "oracle.md"),
			`---
name: oracle
description: broken
models:
  - model: inherit
    thinking: ultra
sandbox_fs: read-only
sandbox_net: allow-all
approval_policy: never
approval_timeout: 60
---

broken
`,
		);

		writeFile(
			path.join(tempProject, ".pi", "agents", "oracle.md"),
			validAgentMarkdown("oracle"),
		);

		vi.stubEnv("HOME", tempHome);

		expect(() => AgentRegistry.load(tempProject)).toThrowError(AgentRegistryConfigError);
		expect(() => AgentRegistry.load(tempProject)).toThrow(/Invalid agent definition/);

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("fails when mode agents are defined as markdown files", () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeFile(
			path.join(tempHome, ".pi", "agent", "agents", "smart.md"),
			validAgentMarkdown("smart"),
		);

		vi.stubEnv("HOME", tempHome);

		expect(() => AgentRegistry.load(tempProject)).toThrowError(AgentRegistryConfigError);
		expect(() => AgentRegistry.load(tempProject)).toThrow(/mode agents .* virtual/);

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});
});
