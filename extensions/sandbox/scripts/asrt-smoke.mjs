import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function main() {
	const cmd = process.argv.slice(2).join(" ") || "echo hello";

	// ASRT always prepends default write paths (see getDefaultWritePaths()), including:
	//   $HOME/.claude/debug
	//   $HOME/.npm/_logs
	// If $HOME/.claude is a symlink, bwrap can fail to create/traverse mountpoints
	// under the symlinked component.
	//
	// For this smoke test, use a temp HOME when ~/.claude is a symlink.
	const originalHome = os.homedir();
	const claudePath = path.join(originalHome, ".claude");
	let sandboxHome = originalHome;
	try {
		if (fs.existsSync(claudePath) && fs.lstatSync(claudePath).isSymbolicLink()) {
			sandboxHome = path.join(os.tmpdir(), `tau-asrt-home-${process.getuid?.() ?? "user"}`);
			process.env.HOME = sandboxHome;
		}
	} catch {
		// ignore
	}

	// Best-effort ensure ASRT default write dirs exist for the chosen HOME.
	for (const d of [
		path.join(sandboxHome, ".claude", "debug"),
		path.join(sandboxHome, ".npm", "_logs"),
		"/tmp/claude",
	]) {
		try {
			fs.mkdirSync(d, { recursive: true });
		} catch {
			// ignore
		}
	}

	let SandboxManager;
	try {
		({ SandboxManager } = await import("@anthropic-ai/sandbox-runtime"));
	} catch (err) {
		console.error("Failed to import @anthropic-ai/sandbox-runtime:", err?.message || err);
		process.exit(2);
		return;
	}

	let wrapped;
	try {
		// Important: do not call SandboxManager.initialize() here.
		// initialize() always starts proxy infrastructure (even if we deny all network),
		// which keeps background handles alive and can make smoke tests appear to hang.
		wrapped = await SandboxManager.wrapWithSandbox(cmd, "bash", {
			// IMPORTANT: omit `network` entirely to allow all network.
			// Providing network.allowedDomains (even []) enables network restriction.
			filesystem: {
				denyRead: [],
				// Avoid allowing "." here. If the wrapping process cwd is inside a git repo,
				// ASRT's mandatory deny path handling may attempt to create mountpoints
				// (e.g. .git, .claude) on the host filesystem.
				allowWrite: ["/tmp"],
				denyWrite: [],
				allowGitConfig: true,
			},
			// No need to scan for nested dangerous paths during a smoke test.
			mandatoryDenySearchDepth: 0,
		});
	} catch (err) {
		console.error("SandboxManager.wrapWithSandbox() failed:", err?.message || err);
		process.exit(4);
		return;
	}

	const child = spawn("bash", ["-lc", wrapped], { stdio: "inherit" });
	child.on("close", (code) => process.exit(code ?? 0));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
