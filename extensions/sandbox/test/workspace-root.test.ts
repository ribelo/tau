import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import { discoverWorkspaceRoot } from "../src/workspace-root.js";

const tmpBase = path.join(os.tmpdir(), `tau-sandbox-workspace-root-${Date.now()}-${Math.random().toString(16).slice(2)}`);

function hasGit(): boolean {
	try {
		const res = spawnSync("git", ["--version"], { encoding: "utf-8" });
		return res.status === 0;
	} catch {
		return false;
	}
}

describe("discoverWorkspaceRoot", () => {
	beforeEach(() => {
		fs.rmSync(tmpBase, { recursive: true, force: true });
		fs.mkdirSync(tmpBase, { recursive: true });
	});

	it("returns cwd when not in a git repo", () => {
		const dir = path.join(tmpBase, "plain");
		fs.mkdirSync(dir, { recursive: true });
		expect(discoverWorkspaceRoot(dir)).toBe(fs.realpathSync(dir));
	});

	it.runIf(hasGit())("returns git repo root when inside a repo", () => {
		const repo = path.join(tmpBase, "repo");
		const nested = path.join(repo, "a", "b");
		fs.mkdirSync(nested, { recursive: true });

		const init = spawnSync("git", ["-C", repo, "init"], { encoding: "utf-8" });
		expect(init.status).toBe(0);

		const root = discoverWorkspaceRoot(nested);
		expect(root).toBe(fs.realpathSync(repo));
	});
});
