import { afterEach, describe, expect, it, vi } from "vitest";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { validateAgentDefinitionsAtStartup } from "../src/agent/startup-validation.js";

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

describe("agent startup validation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("allows startup when user agent markdown files are valid", () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeFile(
			path.join(tempHome, ".pi", "agent", "agents", "oracle.md"),
			validAgentMarkdown("oracle"),
		);

		vi.stubEnv("HOME", tempHome);

		const log = vi.fn<(message: string) => void>();
		const exit = vi.fn((code: number): never => {
			throw new Error(`EXIT:${code}`);
		});

		validateAgentDefinitionsAtStartup(tempProject, { log, exit });

		expect(log).not.toHaveBeenCalled();
		expect(exit).not.toHaveBeenCalled();

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("exits startup with corrupted file paths when markdown is invalid", () => {
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

		let logged = "";
		const log = (message: string) => {
			logged = message;
		};
		const exit = vi.fn((code: number): never => {
			throw new Error(`EXIT:${code}`);
		});

		expect(() => {
			validateAgentDefinitionsAtStartup(tempProject, { log, exit });
		}).toThrow("EXIT:1");

		expect(exit).toHaveBeenCalledWith(1);
		expect(logged).toContain("pi failed to start: invalid agent definition markdown detected.");
		expect(logged).toContain("broken-one.md");
		expect(logged).toContain("broken-two.md");

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});
});
