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
}): Promise<WrapCommandResult> {
	const { command, workspaceRoot, filesystemMode, networkMode } = opts;

	// Optimization: If full access is requested, skip sandbox entirely
	if (filesystemMode === "danger-full-access" && networkMode === "allow-all") {
		return {
			success: true,
			wrappedCommand: command,
			home: os.homedir(), 
		};
	}

	if (!(await isAsrtAvailable())) {
		return { success: false, error: getAsrtLoadError()! };
	}

	cleanupWorkspaceArtifacts(workspaceRoot);

	const resolvedWorkspace = safeRealpath(workspaceRoot);
	const args: string[] = ["bwrap", "--die-with-parent"];

	// Base bindings - use dev-bind to host devices to avoid mknod failures in restricted environments
	args.push(
		"--dev-bind", "/dev", "/dev",
		"--proc", "/proc",
		"--tmpfs", "/tmp",
		"--tmpfs", "/run",
	);

	// NixOS and other systems
	const bindPaths = ["/nix", "/bin", "/sbin", "/etc", "/run/current-system", "/lib64", "/usr", "/lib"];
	for (const p of bindPaths) {
		if (exists(p)) {
			args.push("--ro-bind", p, p);
		}
	}

	// Filesystem permissions
	// For read-only and workspace-write, we need the home directory readable
	const home = os.homedir();
	const resolvedHome = safeRealpath(home);

	if (filesystemMode === "read-only") {
		// Entire home is read-only, workspace is read-only
		args.push("--ro-bind", resolvedHome, resolvedHome);
		// Workspace binding comes after home so it takes precedence if workspace is under home
		if (!resolvedWorkspace.startsWith(resolvedHome)) {
			args.push("--ro-bind", resolvedWorkspace, resolvedWorkspace);
		}
	} else if (filesystemMode === "workspace-write") {
		// Home is read-only, workspace is writable
		args.push("--ro-bind", resolvedHome, resolvedHome);
		// Workspace binding comes after home so it takes precedence (writable overlay)
		args.push("--bind", resolvedWorkspace, resolvedWorkspace);
	} else if (filesystemMode === "danger-full-access") {
		args.push("--bind", "/", "/");
	}

	// Network permissions
	if (networkMode === "deny") {
		args.push("--unshare-net");
	}

	// Keep HOME as real home directory (read-only in sandbox)
	// Tools that try to write to ~/.config, ~/.cache will fail - that's intended
	
	// Final command assembly. Use single quotes to prevent host expansion of $vars.
	const escapedCommand = command.replace(/'/g, "'\\''");
	const wrapped = `${args.join(" ")} -- bash -c '${escapedCommand}'`;

	return {
		success: true,
		wrappedCommand: wrapped,
		home: resolvedHome,
	};
}
