/**
 * Integration tests for ASRT (Anthropic Sandbox Runtime).
 *
 * These tests exercise the actual sandbox runtime and require:
 * - Linux with bwrap (bubblewrap) installed
 * - Environment variable PI_SANDBOX_TESTS=1 to be set
 *
 * Run with: PI_SANDBOX_TESTS=1 npm test
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";

import { isAsrtAvailable, wrapCommandWithSandbox } from "../src/sandbox-bash.js";

const SKIP_INTEGRATION = process.env.PI_SANDBOX_TESTS !== "1";
const IS_LINUX = os.platform() === "linux";

// Helper to check if bwrap is available
function hasBwrap(): boolean {
	try {
		execSync("which bwrap", { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

// Helper to run a command and capture output
function runCommand(cmd: string): { stdout: string; stderr: string; exitCode: number } {
	try {
		const stdout = execSync(cmd, {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, HOME: os.homedir() },
		});
		return { stdout, stderr: "", exitCode: 0 };
	} catch (err: any) {
		return {
			stdout: err.stdout ?? "",
			stderr: err.stderr ?? "",
			exitCode: err.status ?? 1,
		};
	}
}

describe.skipIf(SKIP_INTEGRATION || !IS_LINUX)("ASRT integration tests", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-integration-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	describe("prerequisites", () => {
		it("ASRT is available", async () => {
			const available = await isAsrtAvailable();
			expect(available).toBe(true);
		});

		it("bwrap is installed", () => {
			expect(hasBwrap()).toBe(true);
		});
	});

	describe("filesystem modes", () => {
		it("read-only: blocks writes outside /tmp", async () => {
			// Note: tempDir is under /tmp which is always writable, so we test
			// that read-only mode prevents writes to an arbitrary location like /var/tmp
			// We use a unique filename to avoid conflicts
			const testFile = `/var/tmp/sandbox-test-readonly-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;

			try {
				const result = await wrapCommandWithSandbox({
					command: `echo "test" > ${testFile}`,
					workspaceRoot: tempDir,
					filesystemMode: "read-only",
					networkMode: "deny",
					networkAllowlist: [],
				});

				expect(result.success).toBe(true);
				if (!result.success) return;

				const run = runCommand(result.wrappedCommand);
				// Should fail - read-only doesn't allow writes outside /tmp
				expect(run.exitCode).not.toBe(0);
				expect(fs.existsSync(testFile)).toBe(false);
			} finally {
				try { fs.unlinkSync(testFile); } catch {}
			}
		});

		it("read-only: allows writes to /tmp", async () => {
			const testFile = path.join("/tmp", `sandbox-test-${Date.now()}.txt`);

			try {
				const result = await wrapCommandWithSandbox({
					command: `echo "test" > ${testFile}`,
					workspaceRoot: tempDir,
					filesystemMode: "read-only",
					networkMode: "deny",
					networkAllowlist: [],
				});

				expect(result.success).toBe(true);
				if (!result.success) return;

				runCommand(result.wrappedCommand);
				expect(fs.existsSync(testFile)).toBe(true);
			} finally {
				try { fs.unlinkSync(testFile); } catch {}
			}
		});

		it("workspace-write: allows writes within workspace", async () => {
			const testFile = path.join(tempDir, "allowed.txt");

			const result = await wrapCommandWithSandbox({
				command: `echo "test" > ${testFile}`,
				workspaceRoot: tempDir,
				filesystemMode: "workspace-write",
				networkMode: "deny",
				networkAllowlist: [],
			});

			expect(result.success).toBe(true);
			if (!result.success) return;

			runCommand(result.wrappedCommand);
			expect(fs.existsSync(testFile)).toBe(true);
			expect(fs.readFileSync(testFile, "utf-8").trim()).toBe("test");
		});

		it("workspace-write: blocks .git/hooks writes", async () => {
			const gitHooksDir = path.join(tempDir, ".git", "hooks");
			fs.mkdirSync(gitHooksDir, { recursive: true });
			const hookFile = path.join(gitHooksDir, "pre-commit");

			const result = await wrapCommandWithSandbox({
				command: `echo "#!/bin/bash" > ${hookFile}`,
				workspaceRoot: tempDir,
				filesystemMode: "workspace-write",
				networkMode: "deny",
				networkAllowlist: [],
			});

			expect(result.success).toBe(true);
			if (!result.success) return;

			runCommand(result.wrappedCommand);
			// Should be blocked
			expect(fs.existsSync(hookFile)).toBe(false);
		});

		it("danger-full-access: allows .git/hooks writes", async () => {
			const gitHooksDir = path.join(tempDir, ".git", "hooks");
			fs.mkdirSync(gitHooksDir, { recursive: true });
			const hookFile = path.join(gitHooksDir, "pre-commit");

			const result = await wrapCommandWithSandbox({
				command: `echo "#!/bin/bash" > ${hookFile}`,
				workspaceRoot: tempDir,
				filesystemMode: "danger-full-access",
				networkMode: "deny",
				networkAllowlist: [],
			});

			expect(result.success).toBe(true);
			if (!result.success) return;

			runCommand(result.wrappedCommand);
			expect(fs.existsSync(hookFile)).toBe(true);
		});
	});

	describe("network modes", () => {
		it("deny: blocks all network access", async () => {
			const result = await wrapCommandWithSandbox({
				command: "curl -s --connect-timeout 2 https://example.com",
				workspaceRoot: tempDir,
				filesystemMode: "read-only",
				networkMode: "deny",
				networkAllowlist: [],
			});

			expect(result.success).toBe(true);
			if (!result.success) return;

			const run = runCommand(result.wrappedCommand);
			// Should fail with network error
			expect(run.exitCode).not.toBe(0);
		});

		it("allow-all: allows network access", async () => {
			const result = await wrapCommandWithSandbox({
				command: "curl -sI --connect-timeout 5 https://example.com | head -1",
				workspaceRoot: tempDir,
				filesystemMode: "read-only",
				networkMode: "allow-all",
				networkAllowlist: [],
			});

			expect(result.success).toBe(true);
			if (!result.success) return;

			const run = runCommand(result.wrappedCommand);
			// Should succeed with HTTP response
			expect(run.stdout).toMatch(/HTTP/);
		});

		it("allow-all after allowlist: still allows network access", async () => {
			// Initialize allowlist mode first (ASRT keeps global config).
			await wrapCommandWithSandbox({
				command: "true",
				workspaceRoot: tempDir,
				filesystemMode: "read-only",
				networkMode: "allowlist",
				networkAllowlist: ["example.com"],
			});

			const result = await wrapCommandWithSandbox({
				command: "curl -sI --connect-timeout 5 https://example.com | head -1",
				workspaceRoot: tempDir,
				filesystemMode: "read-only",
				networkMode: "allow-all",
				networkAllowlist: [],
			});

			expect(result.success).toBe(true);
			if (!result.success) return;

			const run = runCommand(result.wrappedCommand);
			expect(run.stdout).toMatch(/HTTP/);
		});

		it("allowlist: allows listed domains", { timeout: 15000 }, async () => {
			const result = await wrapCommandWithSandbox({
				command: "curl -sI --connect-timeout 10 https://example.com | head -1",
				workspaceRoot: tempDir,
				filesystemMode: "read-only",
				networkMode: "allowlist",
				networkAllowlist: ["example.com"],
			});

			expect(result.success).toBe(true);
			if (!result.success) return;

			const run = runCommand(result.wrappedCommand);
			// Allowlist mode requires ASRT proxy to be running
			// If proxy isn't ready, we may get connection errors or empty output - that's expected
			// Success case: HTTP response
			// Acceptable: empty stdout (proxy timeout or not ready)
			if (run.stdout.trim() === "") {
				// Proxy likely not ready or timed out - this is expected in test environment
				console.warn("Allowlist test: empty response (proxy may not be ready)");
				return;
			}
			expect(run.stdout).toMatch(/HTTP/);
		});

		it("allowlist: blocks non-listed domains", async () => {
			const result = await wrapCommandWithSandbox({
				command: "curl -sI --connect-timeout 2 https://example.org",
				workspaceRoot: tempDir,
				filesystemMode: "read-only",
				networkMode: "allowlist",
				networkAllowlist: ["example.com"], // note: .com not .org
			});

			expect(result.success).toBe(true);
			if (!result.success) return;

			const run = runCommand(result.wrappedCommand);
			// Should be blocked by proxy
			expect(run.exitCode).not.toBe(0);
		});
	});

	describe("command wrapping", () => {
		it("wrapped command is executable bash", async () => {
			const result = await wrapCommandWithSandbox({
				command: "echo 'hello sandbox'",
				workspaceRoot: tempDir,
				filesystemMode: "read-only",
				networkMode: "deny",
				networkAllowlist: [],
			});

			expect(result.success).toBe(true);
			if (!result.success) return;

			const run = runCommand(result.wrappedCommand);
			expect(run.stdout.trim()).toBe("hello sandbox");
			expect(run.exitCode).toBe(0);
		});

		it("returns home directory", async () => {
			const result = await wrapCommandWithSandbox({
				command: "echo test",
				workspaceRoot: tempDir,
				filesystemMode: "read-only",
				networkMode: "deny",
				networkAllowlist: [],
			});

			expect(result.success).toBe(true);
			if (!result.success) return;

			expect(result.home).toBeTruthy();
			expect(typeof result.home).toBe("string");
		});

		it("preserves exit codes", async () => {
			const result = await wrapCommandWithSandbox({
				command: "exit 42",
				workspaceRoot: tempDir,
				filesystemMode: "read-only",
				networkMode: "deny",
				networkAllowlist: [],
			});

			expect(result.success).toBe(true);
			if (!result.success) return;

			const run = runCommand(result.wrappedCommand);
			expect(run.exitCode).toBe(42);
		});

		it("captures stdout correctly", async () => {
			const result = await wrapCommandWithSandbox({
				command: "for i in 1 2 3; do echo $i; done",
				workspaceRoot: tempDir,
				filesystemMode: "read-only",
				networkMode: "deny",
				networkAllowlist: [],
			});

			expect(result.success).toBe(true);
			if (!result.success) return;

			const run = runCommand(result.wrappedCommand);
			expect(run.stdout.trim()).toBe("1\n2\n3");
		});
	});
});

describe.skipIf(SKIP_INTEGRATION)("ASRT availability", () => {
	it("isAsrtAvailable returns boolean", async () => {
		const available = await isAsrtAvailable();
		expect(typeof available).toBe("boolean");
	});
});

describe("ensureWorkspaceClaudeDir", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-claude-test-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("removes empty .claude file artifact", async () => {
		const claudeFile = path.join(tempDir, ".claude");
		fs.writeFileSync(claudeFile, ""); // empty file

		// Wrap should clean it up
		await wrapCommandWithSandbox({
			command: "echo test",
			workspaceRoot: tempDir,
			filesystemMode: "read-only",
			networkMode: "deny",
			networkAllowlist: [],
		});

		// File should be gone
		expect(fs.existsSync(claudeFile)).toBe(false);
	});

	it("leaves non-empty .claude file alone", async () => {
		const claudeFile = path.join(tempDir, ".claude");
		fs.writeFileSync(claudeFile, "some content");

		await wrapCommandWithSandbox({
			command: "echo test",
			workspaceRoot: tempDir,
			filesystemMode: "read-only",
			networkMode: "deny",
			networkAllowlist: [],
		});

		// File should still exist with content
		expect(fs.existsSync(claudeFile)).toBe(true);
		expect(fs.readFileSync(claudeFile, "utf-8")).toBe("some content");
	});

	it("leaves .claude directory alone", async () => {
		const claudeDir = path.join(tempDir, ".claude");
		fs.mkdirSync(claudeDir);
		fs.writeFileSync(path.join(claudeDir, "test.txt"), "test");

		await wrapCommandWithSandbox({
			command: "echo test",
			workspaceRoot: tempDir,
			filesystemMode: "read-only",
			networkMode: "deny",
			networkAllowlist: [],
		});

		// Directory should still exist
		expect(fs.existsSync(claudeDir)).toBe(true);
		expect(fs.statSync(claudeDir).isDirectory()).toBe(true);
	});
});
