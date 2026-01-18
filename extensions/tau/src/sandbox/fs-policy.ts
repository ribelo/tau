import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { FilesystemMode } from "./config.js";

export type FsCheckResult =
	| { allowed: true }
	| { allowed: false; reason: string };

/**
 * Resolve a path to its real absolute path.
 * If the file doesn't exist yet, resolve the parent directory and append the filename.
 */
function safeRealpath(targetPath: string): string {
	const absolute = path.isAbsolute(targetPath) ? targetPath : path.resolve(targetPath);

	try {
		return fs.realpathSync(absolute);
	} catch {
		// File doesn't exist yet - resolve parent and append filename
		const parent = path.dirname(absolute);
		const filename = path.basename(absolute);
		try {
			return path.join(fs.realpathSync(parent), filename);
		} catch {
			// Parent doesn't exist either - return as-is
			return absolute;
		}
	}
}

/**
 * Check if a path is under a given root directory.
 */
function isUnderRoot(targetPath: string, root: string): boolean {
	const resolved = safeRealpath(targetPath);
	const resolvedRoot = safeRealpath(root);

	// Normalize both paths to ensure consistent comparison
	const normalizedTarget = path.normalize(resolved);
	const normalizedRoot = path.normalize(resolvedRoot);

	// Check if target starts with root (with proper path separator handling)
	return (
		normalizedTarget === normalizedRoot ||
		normalizedTarget.startsWith(normalizedRoot + path.sep)
	);
}

/**
 * Check if a path is in a temp directory (/tmp, $TMPDIR, os.tmpdir()).
 */
function isInTempDir(targetPath: string): boolean {
	const resolved = safeRealpath(targetPath);
	const tmpDirs = new Set<string>();

	// Add standard temp directories
	tmpDirs.add("/tmp");
	try {
		tmpDirs.add(fs.realpathSync("/tmp"));
	} catch {
		// ignore
	}

	// Add os.tmpdir()
	const osTmp = os.tmpdir();
	tmpDirs.add(osTmp);
	try {
		tmpDirs.add(fs.realpathSync(osTmp));
	} catch {
		// ignore
	}

	// Add $TMPDIR if set
	const envTmpDir = process.env.TMPDIR;
	if (envTmpDir) {
		tmpDirs.add(envTmpDir);
		try {
			tmpDirs.add(fs.realpathSync(envTmpDir));
		} catch {
			// ignore
		}
	}

	for (const tmpDir of tmpDirs) {
		if (isUnderRoot(resolved, tmpDir)) {
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
		return isUnderRoot(resolved, resolvedHooksDir);
	} catch {
		// .git/hooks doesn't exist - check pattern match
		return resolved.includes(`${path.sep}.git${path.sep}hooks${path.sep}`) ||
			resolved.endsWith(`${path.sep}.git${path.sep}hooks`);
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
			if (isUnderRoot(resolved, workspaceRoot)) {
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
