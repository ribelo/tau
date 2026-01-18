import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { FilesystemMode, NetworkMode } from "./config.js";

// Lazy-loaded ASRT module
let SandboxManager: any = null;
let asrtLoadError: Error | null = null;
let asrtLoadAttempted = false;

/**
 * Attempt to load the ASRT SandboxManager.
 * Throws on failure.
 */
async function loadAsrt(): Promise<any> {
	if (asrtLoadAttempted) {
		if (asrtLoadError) throw asrtLoadError;
		return SandboxManager;
	}

	asrtLoadAttempted = true;

	try {
		const mod = await import("@anthropic-ai/sandbox-runtime");
		SandboxManager = mod.SandboxManager;
		return SandboxManager;
	} catch (err) {
		asrtLoadError = err instanceof Error ? err : new Error(String(err));
		throw asrtLoadError;
	}
}

/**
 * Check if ASRT is available (without throwing).
 */
export async function isAsrtAvailable(): Promise<boolean> {
	try {
		await loadAsrt();
		return true;
	} catch {
		return false;
	}
}

/**
 * Get the error message if ASRT failed to load.
 */
export function getAsrtLoadError(): string | null {
	return asrtLoadError?.message ?? null;
}

function getUserHomeDir(): string {
	// Prefer passwd-derived home (not process.env.HOME), so we don't accidentally
	// inherit a previously-mutated HOME.
	try {
		return os.userInfo().homedir;
	} catch {
		return os.homedir();
	}
}

/**
 * Resolve symlinks, while still working for paths that don't exist yet.
 *
 * - If targetPath exists: returns fs.realpathSync(targetPath)
 * - If missing: resolves the parent and appends the basename
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

function mkdirp(p: string): void {
	try {
		fs.mkdirSync(p, { recursive: true });
	} catch {
		// ignore
	}
}

/**
 * ASRT adds default writable mounts including:
 * - ~/.claude/debug
 * - ~/.npm/_logs
 * - /tmp/claude
 *
 * If ~/.claude is a symlink into dotfiles, bwrap may fail unless these
 * directories already exist at the resolved target.
 */
function ensureAsrtDefaultDirsExist(home: string): void {
	const defaults = [
		path.join(home, ".claude", "debug"),
		path.join(home, ".npm", "_logs"),
		"/tmp/claude",
	];

	for (const p of defaults) {
		mkdirp(safeRealpath(p));
	}
}

function uniq(values: string[]): string[] {
	return [...new Set(values)];
}

export type WrapCommandResult =
	| { success: true; wrappedCommand: string; home: string }
	| { success: false; error: string };

/**
 * Wrap a bash command with ASRT sandbox restrictions.
 *
 * Strategy for symlinked dotfiles:
 * - Keep HOME stable for the executed command (real user home)
 * - Pre-create ASRT default writable dirs at their resolved targets
 * - Add resolved targets of the ASRT default dirs to allowWrite
 */
export async function wrapCommandWithSandbox(opts: {
	command: string;
	workspaceRoot: string;
	filesystemMode: FilesystemMode;
	networkMode: NetworkMode;
	networkAllowlist: string[];
}): Promise<WrapCommandResult> {
	const { command, workspaceRoot, filesystemMode, networkMode, networkAllowlist } = opts;

	let mgr: any;
	try {
		mgr = await loadAsrt();
	} catch (err) {
		return {
			success: false,
			error: `ASRT not available: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	const home = getUserHomeDir();
	ensureAsrtDefaultDirsExist(home);

	const resolvedWorkspace = safeRealpath(workspaceRoot);

	// Include the resolved targets of ASRT defaults so writes through symlinks work.
	const asrtDefaultWritableTargets = uniq([
		safeRealpath(path.join(home, ".claude", "debug")),
		safeRealpath(path.join(home, ".npm", "_logs")),
		// /tmp is always writable anyway, but keep the explicit resolved path for completeness.
		safeRealpath("/tmp/claude"),
	]);

	// Build filesystem config
	const allowWrite: string[] = ["/tmp", ...asrtDefaultWritableTargets];
	const denyWrite: string[] = [];

	switch (filesystemMode) {
		case "danger-full-access":
			// Allow everything - but still go through ASRT for network control.
			allowWrite.push("/");
			break;
		case "workspace-write":
			allowWrite.push(resolvedWorkspace);
			// Deny .git/hooks even in workspace-write mode
			denyWrite.push(path.join(resolvedWorkspace, ".git", "hooks"));
			break;
		case "read-only":
			// Only /tmp + ASRT defaults are allowed.
			break;
	}

	// Build network config
	let allowedDomains: string[] = [];
	let deniedDomains: string[] = [];

	switch (networkMode) {
		case "allow-all":
			// ASRT: empty arrays = no restrictions
			break;
		case "allowlist":
			allowedDomains = [...networkAllowlist];
			break;
		case "deny":
			deniedDomains = ["*"];
			break;
	}

	try {
		const wrapped = await mgr.wrapWithSandbox(command, "bash", {
			network: { allowedDomains, deniedDomains },
			filesystem: {
				denyRead: [],
				allowWrite,
				denyWrite,
				allowGitConfig: true,
			},
			mandatoryDenySearchDepth: 2,
		});

		return {
			success: true,
			wrappedCommand: wrapped,
			home,
		};
	} catch (err) {
		return {
			success: false,
			error: `ASRT wrap failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}
