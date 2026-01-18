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
 * Returns null if not available.
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

/**
 * Ensure directories that ASRT needs exist.
 * ASRT adds default write paths including ~/.claude/debug and ~/.npm/_logs.
 */
function ensureAsrtDirs(home: string): void {
	const dirs = [
		path.join(home, ".claude", "debug"),
		path.join(home, ".npm", "_logs"),
		"/tmp/claude",
	];

	for (const dir of dirs) {
		try {
			fs.mkdirSync(dir, { recursive: true });
		} catch {
			// ignore
		}
	}
}

/**
 * Get HOME directory for sandbox.
 * If ~/.claude is a symlink, use a temp HOME to avoid bwrap issues.
 */
function getSandboxHome(): string {
	const originalHome = os.homedir();
	const claudePath = path.join(originalHome, ".claude");

	try {
		if (fs.existsSync(claudePath) && fs.lstatSync(claudePath).isSymbolicLink()) {
			const tempHome = path.join(os.tmpdir(), `tau-asrt-home-${process.getuid?.() ?? "user"}`);
			return tempHome;
		}
	} catch {
		// ignore
	}

	return originalHome;
}

export type WrapCommandResult =
	| { success: true; wrappedCommand: string; home: string }
	| { success: false; error: string };

/**
 * Wrap a bash command with ASRT sandbox restrictions.
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

	const sandboxHome = getSandboxHome();
	ensureAsrtDirs(sandboxHome);

	// ASRT reads process.env.HOME at wrap time to compute default paths
	const originalHome = process.env.HOME;
	process.env.HOME = sandboxHome;

	// Build filesystem config
	const allowWrite: string[] = ["/tmp"];
	const denyWrite: string[] = [];

	switch (filesystemMode) {
		case "danger-full-access":
			// Allow everything - but we still go through ASRT for network control
			allowWrite.push("/");
			break;
		case "workspace-write":
			allowWrite.push(workspaceRoot);
			// Deny .git/hooks even in workspace-write mode
			denyWrite.push(path.join(workspaceRoot, ".git", "hooks"));
			break;
		case "read-only":
			// Only /tmp is allowed (already added above)
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
			// Block everything - use a catch-all deny
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
			// Limit search depth to avoid slowdowns
			mandatoryDenySearchDepth: 2,
		});

		// Restore original HOME
		if (originalHome !== undefined) {
			process.env.HOME = originalHome;
		}

		return {
			success: true,
			wrappedCommand: wrapped,
			home: sandboxHome,
		};
	} catch (err) {
		// Restore original HOME on error too
		if (originalHome !== undefined) {
			process.env.HOME = originalHome;
		}

		return {
			success: false,
			error: `ASRT wrap failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}
