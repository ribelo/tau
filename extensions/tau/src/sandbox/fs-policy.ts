import * as path from "node:path";

import type { FilesystemMode } from "./config.js";
import { collectTempRoots, isPathInsideRoot, safeRealpath } from "../shared/fs.js";

type FsCheckResult = { allowed: true } | { allowed: false; reason: string };

/**
 * Check if a path is in a temp directory (/tmp, $TMPDIR, os.tmpdir()).
 */
function isInTempDir(targetPath: string): boolean {
	const resolved = safeRealpath(targetPath);
	for (const tmpDir of collectTempRoots()) {
		if (isPathInsideRoot(resolved, tmpDir)) {
			return true;
		}
	}

	return false;
}

/**
 * Check if a path is within .git/hooks directory.
 * This is dangerous because git hooks can execute arbitrary code.
 */
function isGitHooksPath(targetPath: string, workspaceRoot: string): boolean {
	const resolved = safeRealpath(targetPath);
	const hooksDir = path.join(workspaceRoot, ".git", "hooks");

	try {
		const resolvedHooksDir = safeRealpath(hooksDir);
		return isPathInsideRoot(resolved, resolvedHooksDir);
	} catch {
		// .git/hooks doesn't exist - check pattern match
		return (
			resolved.includes(`${path.sep}.git${path.sep}hooks${path.sep}`) ||
			resolved.endsWith(`${path.sep}.git${path.sep}hooks`)
		);
	}
}

/**
 * Check if a write operation is allowed based on filesystem mode.
 */
export function checkWriteAllowed(opts: {
	targetPath: string;
	workspaceRoot: string;
	filesystemMode: FilesystemMode;
}): FsCheckResult {
	const { targetPath, workspaceRoot, filesystemMode } = opts;
	const resolved = safeRealpath(targetPath);

	// Always deny .git/hooks unless danger-full-access
	if (filesystemMode !== "danger-full-access" && isGitHooksPath(resolved, workspaceRoot)) {
		return {
			allowed: false,
			reason: `Write to .git/hooks is blocked for security (path: ${resolved}). Use /sandbox to enable danger-full-access mode if needed.`,
		};
	}

	switch (filesystemMode) {
		case "danger-full-access":
			return { allowed: true };

		case "workspace-write":
			// Allow writes under workspace root
			if (isPathInsideRoot(resolved, workspaceRoot)) {
				return { allowed: true };
			}
			// Allow writes to temp directories
			if (isInTempDir(resolved)) {
				return { allowed: true };
			}
			return {
				allowed: false,
				reason: `Write outside workspace is blocked (path: ${resolved}, workspace: ${workspaceRoot}). Use /sandbox to change filesystem mode.`,
			};

		case "read-only":
			// Only allow writes to temp directories
			if (isInTempDir(resolved)) {
				return { allowed: true };
			}
			return {
				allowed: false,
				reason: `Filesystem is read-only (path: ${resolved}). Use /sandbox to change filesystem mode.`,
			};

		default:
			return {
				allowed: false,
				reason: `Unknown filesystem mode: ${filesystemMode}`,
			};
	}
}
