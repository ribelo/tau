import { afterEach, describe, expect, it, vi } from "vitest";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";

import { AgentRegistry } from "../src/agent/agent-registry.js";
import { validateResolvedAgentConfiguration } from "../src/agent/startup-validation.js";

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
sandbox: read-only
approval_timeout: 60
---

You are ${name}.
`;
}

function runValidation(cwd: string) {
	return Effect.runPromise(
		AgentRegistry.load(cwd).pipe(Effect.flatMap(validateResolvedAgentConfiguration)),
	);
}

describe("agent startup validation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("allows startup when user agent markdown files are valid", async () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeFile(
			path.join(tempHome, ".pi", "agent", "agents", "oracle.md"),
			validAgentMarkdown("oracle"),
		);

		vi.stubEnv("HOME", tempHome);

		await expect(runValidation(tempProject)).resolves.toBeUndefined();

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("fails startup with corrupted file paths when markdown is invalid", async () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeFile(
			path.join(tempHome, ".pi", "agent", "agents", "broken-one.md"),
			"this file is not valid frontmatter",
		);
		writeFile(
			path.join(tempHome, ".pi", "agent", "agents", "broken-two.md"),
			"---\nname: broken-two\ndescription: broken\n---",
		);

		vi.stubEnv("HOME", tempHome);

		await expect(runValidation(tempProject)).rejects.toThrow("broken-one.md");

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("fails startup when a bundled agent references unavailable tools", async () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeFile(
			path.join(tempHome, ".pi", "agent", "settings.json"),
			JSON.stringify(
				{
					agents: {
						deep: {
							tools: ["read", "imaginary_tool"],
						},
					},
				},
				null,
				2,
			),
		);

		vi.stubEnv("HOME", tempHome);

		await expect(runValidation(tempProject)).rejects.toThrow(
			'Invalid tools for agent "deep": imaginary_tool',
		);

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("allows startup when a bundled agent uses backlog as its planning tool", async () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeFile(
			path.join(tempHome, ".pi", "agent", "settings.json"),
			JSON.stringify(
				{
					agents: {
						deep: {
							tools: ["read", "backlog"],
						},
					},
				},
				null,
				2,
			),
		);

		vi.stubEnv("HOME", tempHome);

		await expect(runValidation(tempProject)).resolves.toBeUndefined();

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});
});
