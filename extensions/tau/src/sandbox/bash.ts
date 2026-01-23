import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";

import type { FilesystemMode, NetworkMode } from "./config.js";

/**
 * Check if bwrap is available on the system.
 */
export async function isAsrtAvailable(): Promise<boolean> {
	try {
		execSync("bwrap --version", { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/**
 * Get error message if bwrap is missing.
 */
export function getAsrtLoadError(): string | null {
	return "bubblewrap (bwrap) is not installed or not in PATH. It is required for sandboxed execution.";
}

/**
 * Resolve symlinks, while still working for paths that don't exist yet.
 */
function safeRealpath(targetPath: string): string {
	try {
		return fs.realpathSync(targetPath);
	} catch {
		try {
			const parent = path.dirname(targetPath);
			const base = path.basename(targetPath);
			const resolvedParent = fs.realpathSync(parent);
			return path.join(resolvedParent, base);
		} catch {
			return targetPath;
		}
	}
}

/**
 * Check if a path exists.
 */
function exists(p: string): boolean {
	try {
		fs.accessSync(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * ASRT/bwrap may leave 0-byte artifacts in the workspace if interrupted.
 * Clean up these known artifacts.
 */
function cleanupWorkspaceArtifacts(workspaceRoot: string): void {
	const artifacts = [
		".bash_profile",
		".bashrc",
		".claude",
		".gitconfig",
		".gitmodules",
		".idea",
		".mcp.json",
		".profile",
		".ripgreprc",
		".vscode",
		".zprofile",
		".zshrc",
	];

	for (const artifact of artifacts) {
		const p = path.join(workspaceRoot, artifact);
		try {
			const stat = fs.lstatSync(p);
			// Only delete if it's a regular file and exactly 0 bytes (classic bwrap artifact)
			if (stat.isFile() && stat.size === 0) {
				fs.unlinkSync(p);
			}
		} catch {
			// Doesn't exist or no permission - skip
		}
	}
}

export type WrapCommandResult =
	| { success: true; wrappedCommand: string; home: string }
	| { success: false; error: string };

/**
 * Wrap a bash command with bwrap sandbox restrictions.
 * 
 * Ported from erg/packages/core/src/sandbox/bwrap.ts
 */
export async function wrapCommandWithSandbox(opts: {
	command: string;
	workspaceRoot: string;
	filesystemMode: FilesystemMode;
	networkMode: NetworkMode;
	networkAllowlist: string[];
}): Promise<WrapCommandResult> {
	const { command, workspaceRoot, filesystemMode, networkMode } = opts;

	if (!(await isAsrtAvailable())) {
		return { success: false, error: getAsrtLoadError()! };
	}

	cleanupWorkspaceArtifacts(workspaceRoot);

	const resolvedWorkspace = safeRealpath(workspaceRoot);
	const args: string[] = ["bwrap", "--die-with-parent"];

	// Base bindings
	args.push(
		"--dev", "/dev",
		"--proc", "/proc",
		"--tmpfs", "/tmp",
		"--tmpfs", "/run",
		"--ro-bind", "/usr", "/usr",
		"--ro-bind", "/lib", "/lib",
	);

	// Optional system paths
	const optionalPaths = ["/lib64", "/bin", "/sbin", "/etc", "/nix/store", "/run/current-system"];
	for (const p of optionalPaths) {
		if (exists(p)) {
			args.push("--ro-bind", p, p);
		}
	}

	// Filesystem permissions
	if (filesystemMode === "read-only") {
		args.push("--ro-bind", resolvedWorkspace, resolvedWorkspace);
	} else if (filesystemMode === "workspace-write") {
		args.push("--bind", resolvedWorkspace, resolvedWorkspace);
	} else if (filesystemMode === "danger-full-access") {
		args.push("--bind", "/", "/");
	}

	// Network permissions
	if (networkMode === "deny" || networkMode === "allowlist") {
		// allowlist is treated as deny for now, as we don't have a simple proxy
		args.push("--unshare-net");
	}

	// Set HOME to workspace root to avoid leaking real HOME artifacts
	args.push("--setenv", "HOME", resolvedWorkspace);
	
	// Final command assembly
	const wrapped = `${args.join(" ")} -- bash -lc ${JSON.stringify(command)}`;

	return {
		success: true,
		wrappedCommand: wrapped,
		home: resolvedWorkspace,
	};
}
