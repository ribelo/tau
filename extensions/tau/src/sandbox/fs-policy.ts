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
 * Check if a path is within the .git directory at workspace root.
 * Protects config, hooks, and all git internals from agent writes.
 */
function isGitPath(targetPath: string, workspaceRoot: string): boolean {
	const resolved = safeRealpath(targetPath);
	const gitDir = path.join(workspaceRoot, ".git");

	try {
		const resolvedGitDir = safeRealpath(gitDir);
		return isPathInsideRoot(resolved, resolvedGitDir);
	} catch {
		return (
			resolved.includes(`${path.sep}.git${path.sep}`) ||
			resolved.endsWith(`${path.sep}.git`)
		);
	}
}

/**
 * Check if a path is within the .pi directory at workspace root.
 * Writes here could tamper with sandbox config for subsequent sessions.
 */
function isPiConfigPath(targetPath: string, workspaceRoot: string): boolean {
	const resolved = safeRealpath(targetPath);
	const piDir = path.join(workspaceRoot, ".pi");

	try {
		const resolvedPiDir = safeRealpath(piDir);
		return isPathInsideRoot(resolved, resolvedPiDir);
	} catch {
		return (
			resolved.includes(`${path.sep}.pi${path.sep}`) ||
			resolved.endsWith(`${path.sep}.pi`)
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

	// Always deny .git/ and .pi/ unless danger-full-access
	if (filesystemMode !== "danger-full-access" && isGitPath(resolved, workspaceRoot)) {
		return {
			allowed: false,
			reason: `Write to .git/ is blocked for security (path: ${resolved}). Use /sandbox to enable danger-full-access mode if needed.`,
		};
	}
	if (filesystemMode !== "danger-full-access" && isPiConfigPath(resolved, workspaceRoot)) {
		return {
			allowed: false,
			reason: `Write to .pi/ is blocked to prevent sandbox config tampering (path: ${resolved}). Use /sandbox to enable danger-full-access mode if needed.`,
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
