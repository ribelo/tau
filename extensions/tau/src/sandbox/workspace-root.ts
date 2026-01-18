import { spawnSync } from "node:child_process";
import * as fs from "node:fs";

/**
 * Determine the workspace root for sandboxing.
 *
 * Rules:
 * - If cwd is inside a git repository, return the repo root (git rev-parse --show-toplevel)
 * - Otherwise return cwd
 *
 * Notes:
 * - This is intentionally best-effort and never throws.
 * - For nested repos/submodules, git returns the nearest containing repo root (reasonable default).
 */
export function discoverWorkspaceRoot(cwd: string): string {
	try {
		const res = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});

		if (res.status === 0) {
			const root = (res.stdout || "").trim();
			if (root && fs.existsSync(root)) {
				try {
					return fs.realpathSync(root);
				} catch {
					return root;
				}
			}
		}
	} catch {
		// ignore
	}

	try {
		return fs.realpathSync(cwd);
	} catch {
		return cwd;
	}
}
