import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { FilesystemMode, NetworkMode } from "./config.js";

// Lazy-loaded ASRT module
type SandboxManagerType = {
	wrapWithSandbox: (command: string, shell: string, config: unknown) => Promise<string>;
	initialize: (config: unknown) => Promise<void>;
	updateConfig: (config: unknown) => void;
	getConfig: () => unknown;
	reset: () => Promise<void>;
};

let SandboxManager: SandboxManagerType | null = null;
let asrtLoadError: Error | null = null;
let asrtLoadAttempted = false;

/**
 * Attempt to load the ASRT SandboxManager.
 * Throws on failure.
 */
async function loadAsrt(): Promise<SandboxManagerType> {
	if (asrtLoadAttempted) {
		if (asrtLoadError) throw asrtLoadError;
		if (!SandboxManager) throw new Error("SandboxManager failed to load");
		return SandboxManager;
	}

	asrtLoadAttempted = true;

	try {
		const mod = await import("@anthropic-ai/sandbox-runtime");
		SandboxManager = mod.SandboxManager;
		if (!SandboxManager) throw new Error("SandboxManager not found in @anthropic-ai/sandbox-runtime");
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
 * Check if ~/.claude is a symlink. If so, ASRT's default mounts won't work
 * because bwrap can't mkdir through symlinks in the mount namespace.
 */
function needsTempHome(realHome: string): boolean {
	const claudePath = path.join(realHome, ".claude");
	try {
		return fs.existsSync(claudePath) && fs.lstatSync(claudePath).isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * Get a temp HOME directory for ASRT to use when real HOME has symlinked dotfiles.
 */
function getTempAsrtHome(): string {
	return path.join(os.tmpdir(), `tau-asrt-home-${process.getuid?.() ?? "user"}`);
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
 * Ensure ASRT default directories exist.
 * When using temp HOME, create the dirs there.
 * When using real HOME, ensure the dirs exist (possibly through symlinks).
 */
function ensureAsrtDirs(home: string): void {
	mkdirp(path.join(home, ".claude", "debug"));
	mkdirp(path.join(home, ".npm", "_logs"));
	mkdirp("/tmp/claude");
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

/**
 * ASRT may try to create .claude/commands in the workspace root.
 * If .claude exists as a file (leftover bwrap artifact), this fails.
 * Clean up empty file artifacts.
 */
function ensureWorkspaceClaudeDir(workspaceRoot: string): void {
	cleanupWorkspaceArtifacts(workspaceRoot);
}

export type WrapCommandResult =
	| { success: true; wrappedCommand: string; home: string }
	| { success: false; error: string };

/**
 * Wrap a bash command with ASRT sandbox restrictions.
 *
 * Strategy for symlinked dotfiles (~/.claude -> ~/.dotfiles/...):
 *
 * Problem: bwrap can't mkdir mount points through symlinks. When ASRT tries
 * to mount ~/.claude/debug and ~/.claude is a symlink, bwrap fails with
 * "Can't mkdir: No such file or directory".
 *
 * Solution: Use a temp HOME for ASRT's internal mount generation, but return
 * the real HOME for the child process. This way:
 * - ASRT generates mounts to temp paths (which work)
 * - The child process uses real HOME (so dotfiles/config are accessible via ro-bind)
 * - The filesystem is readable via --ro-bind / /
 */
export async function wrapCommandWithSandbox(opts: {
	command: string;
	workspaceRoot: string;
	filesystemMode: FilesystemMode;
	networkMode: NetworkMode;
	networkAllowlist: string[];
}): Promise<WrapCommandResult> {
	const { command, workspaceRoot, filesystemMode, networkMode, networkAllowlist } = opts;

	let mgr: SandboxManagerType;
	try {
		mgr = await loadAsrt();
	} catch (err) {
		return {
			success: false,
			error: `ASRT not available: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	const realHome = getUserHomeDir();

	// Determine which HOME to use for ASRT mount generation
	const useTempHome = needsTempHome(realHome);
	const asrtHome = useTempHome ? getTempAsrtHome() : realHome;

	// Ensure ASRT default dirs exist in the chosen home
	ensureAsrtDirs(asrtHome);

	// Clean up any bwrap artifacts in workspace
	ensureWorkspaceClaudeDir(workspaceRoot);

	const resolvedWorkspace = safeRealpath(workspaceRoot);

	// Build filesystem config
	const allowWrite: string[] = ["/tmp"];
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
			// Only /tmp is allowed (plus ASRT defaults).
			break;
	}

	// Build network config
	//
	// ASRT semantics (important):
	// - If network.allowedDomains is PROVIDED (even []), ASRT enables network restriction
	//   and will unshare the network namespace.
	// - An empty allowedDomains means "block all network".
	// - To truly allow all network, you must OMIT the network config entirely.
	let network:
		| {
				allowedDomains: string[];
				deniedDomains: string[];
			}
		| undefined;

	// If ASRT was previously initialized (for allowlist), it will keep a global config.
	// That global config would force network restriction even when we omit `network`.
	// Therefore, when switching to allow-all or deny, we reset ASRT to clear config.
	if (networkMode === "allow-all" || networkMode === "deny") {
		try {
			if (typeof mgr.getConfig === "function" && mgr.getConfig()) {
				await mgr.reset();
			}
		} catch {
			// ignore reset failures; we'll still try to wrap
		}
	}

	switch (networkMode) {
		case "allow-all":
			// Omit `network` entirely
			network = undefined;
			break;
		case "allowlist": {
			// Ensure ASRT is initialized so the network bridge + proxy exist.
			// NOTE: the proxy's filter reads from ASRT's global config, so we must
			// keep it updated with the current allowlist.
			const runtimeConfig = {
				network: {
					allowedDomains: [...networkAllowlist],
					deniedDomains: [],
				},
				filesystem: {
					denyRead: [],
					allowWrite: [],
					denyWrite: [],
					allowGitConfig: true,
				},
				mandatoryDenySearchDepth: 2,
			};

			try {
				if (typeof mgr.getConfig === "function" && mgr.getConfig()) {
					// updateConfig is sync in ASRT
					mgr.updateConfig(runtimeConfig);
				} else {
					await mgr.initialize(runtimeConfig);
				}
			} catch (err) {
				return {
					success: false,
					error: `ASRT network initialization failed: ${err instanceof Error ? err.message : String(err)}`,
				};
			}

			network = {
				allowedDomains: [...networkAllowlist],
				deniedDomains: [],
			};
			break;
		}
		case "deny":
			// Provide an explicit network config with empty allowedDomains = block all.
			network = { allowedDomains: [], deniedDomains: [] };
			break;
	}

	// Temporarily set HOME for ASRT's mount path generation
	const envHomeBackup = process.env.HOME;
	process.env.HOME = asrtHome;

	try {
		const wrapped = await mgr.wrapWithSandbox(command, "bash", {
			...(network ? { network } : {}),
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
			// Return REAL home for the child process - this preserves dotfiles/config
			// The filesystem is readable via --ro-bind / /, writes go to temp paths
			home: realHome,
		};
	} catch (err) {
		return {
			success: false,
			error: `ASRT wrap failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	} finally {
		// Restore HOME
		if (envHomeBackup === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = envHomeBackup;
		}
	}
}
