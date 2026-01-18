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

function getSandboxHome(realHome: string): string {
	const claudePath = path.join(realHome, ".claude");
	try {
		if (fs.existsSync(claudePath) && fs.lstatSync(claudePath).isSymbolicLink()) {
			return path.join(os.tmpdir(), `tau-asrt-home-${process.getuid?.() ?? "user"}`);
		}
	} catch {
		// ignore
	}
	return realHome;
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
	const sandboxHome = getSandboxHome(home);
	ensureAsrtDefaultDirsExist(sandboxHome);

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

	const envHomeBackup = process.env.HOME;
	process.env.HOME = sandboxHome;

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
			home,
		};
	} catch (err) {
		return {
			success: false,
			error: `ASRT wrap failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	} finally {
		if (envHomeBackup === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = envHomeBackup;
		}
	}
}
