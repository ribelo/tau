import { afterEach, describe, expect, it, vi } from "vitest";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";

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

	it("fails when a discovered agent file is invalid", async () => {
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

		await expect(Effect.runPromise(AgentRegistry.load(tempProject))).rejects.toThrowError(
			AgentRegistryConfigError,
		);
		await expect(Effect.runPromise(AgentRegistry.load(tempProject))).rejects.toThrow(
			/Invalid agent definition/,
		);
		await expect(Effect.runPromise(AgentRegistry.load(tempProject))).rejects.toThrow(
			/oracle\.md/,
		);

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("fails when user agent settings are malformed", async () => {
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

		await expect(Effect.runPromise(AgentRegistry.load(tempProject))).rejects.toThrowError(
			AgentRegistryConfigError,
		);
		await expect(Effect.runPromise(AgentRegistry.load(tempProject))).rejects.toThrow(
			/agents\.oracle\.models must be an array/,
		);

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("accepts xhigh in user agent settings", async () => {
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

		const registry = await Effect.runPromise(AgentRegistry.load(tempProject));
		const resolved = registry.resolve("oracle", "medium");
		expect(resolved?.models[0]).toEqual({
			model: "openai-codex/gpt-5.3-codex",
			thinking: "xhigh",
		});

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("accepts tool allowlist overrides in user settings", async () => {
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
							tools: ["read", "bash"],
						},
					},
				},
				null,
				2,
			),
		);

		vi.stubEnv("HOME", tempHome);

		const registry = await Effect.runPromise(AgentRegistry.load(tempProject));
		const resolved = registry.resolve("oracle", "medium");
		expect(resolved?.tools).toEqual(["read", "bash"]);

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("fails when tool allowlist overrides are malformed", async () => {
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
							tools: ["read", "read"],
						},
					},
				},
				null,
				2,
			),
		);

		vi.stubEnv("HOME", tempHome);

		await expect(Effect.runPromise(AgentRegistry.load(tempProject))).rejects.toThrowError(
			AgentRegistryConfigError,
		);
		await expect(Effect.runPromise(AgentRegistry.load(tempProject))).rejects.toThrow(
			/agents\.oracle\.tools\[1\] duplicates "read"/,
		);

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("fails even when invalid lower-priority agent is overridden", async () => {
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

		await expect(Effect.runPromise(AgentRegistry.load(tempProject))).rejects.toThrowError(
			AgentRegistryConfigError,
		);
		await expect(Effect.runPromise(AgentRegistry.load(tempProject))).rejects.toThrow(
			/Invalid agent definition/,
		);

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("accepts tool allowlist overrides for virtual mode agents", async () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeFile(
			path.join(tempHome, ".pi", "agent", "settings.json"),
			JSON.stringify(
				{
					agents: {
						smart: {
							tools: ["read", "bash"],
						},
					},
				},
				null,
				2,
			),
		);

		vi.stubEnv("HOME", tempHome);

		const registry = await Effect.runPromise(AgentRegistry.load(tempProject));
		const resolved = registry.resolve("smart", "medium");
		expect(resolved?.tools).toEqual(["read", "bash"]);

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("fails when virtual mode agents override unsupported keys", async () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeFile(
			path.join(tempHome, ".pi", "agent", "settings.json"),
			JSON.stringify(
				{
					agents: {
						smart: {
							models: [
								{
									model: "inherit",
									thinking: "inherit",
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

		await expect(Effect.runPromise(AgentRegistry.load(tempProject))).rejects.toThrowError(
			AgentRegistryConfigError,
		);
		await expect(Effect.runPromise(AgentRegistry.load(tempProject))).rejects.toThrow(
			/mode agents only support tools here/,
		);

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("fails when mode agents are defined as markdown files", async () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeFile(
			path.join(tempHome, ".pi", "agent", "agents", "smart.md"),
			validAgentMarkdown("smart"),
		);

		vi.stubEnv("HOME", tempHome);

		await expect(Effect.runPromise(AgentRegistry.load(tempProject))).rejects.toThrowError(
			AgentRegistryConfigError,
		);
		await expect(Effect.runPromise(AgentRegistry.load(tempProject))).rejects.toThrow(
			/mode agents .* virtual/,
		);

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});
});
