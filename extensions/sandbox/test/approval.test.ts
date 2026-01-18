import { describe, expect, it, vi } from "vitest";

import {
	checkBashApproval,
	checkFilesystemApproval,
	looksLikePolicyViolation,
	requestApprovalAfterFailure,
} from "../src/approval.js";
import type { ApprovalPolicy } from "../src/config.js";

// Mock ExtensionContext for testing
function createMockContext(opts: { hasUI?: boolean; confirmResult?: boolean } = {}) {
	const { hasUI = true, confirmResult = true } = opts;
	return {
		hasUI,
		ui: {
			confirm: vi.fn().mockResolvedValue(confirmResult),
		},
	} as any;
}

describe("checkBashApproval", () => {
	describe("policy: never", () => {
		it("always approves and runs sandboxed", async () => {
			const ctx = createMockContext();
			const result = await checkBashApproval(ctx, "never", "rm -rf /", false);

			expect(result.approved).toBe(true);
			expect(result).toHaveProperty("runUnsandboxed", false);
			expect(ctx.ui.confirm).not.toHaveBeenCalled();
		});

		it("ignores escalate flag", async () => {
			const ctx = createMockContext();
			const result = await checkBashApproval(ctx, "never", "rm -rf /", true);

			expect(result.approved).toBe(true);
			expect(result).toHaveProperty("runUnsandboxed", false);
		});
	});

	describe("policy: on-failure", () => {
		it("approves and runs sandboxed without prompt", async () => {
			const ctx = createMockContext();
			const result = await checkBashApproval(ctx, "on-failure", "npm install", false);

			expect(result.approved).toBe(true);
			expect(result).toHaveProperty("runUnsandboxed", false);
			expect(ctx.ui.confirm).not.toHaveBeenCalled();
		});

		it("ignores escalate flag (handled separately after failure)", async () => {
			const ctx = createMockContext();
			const result = await checkBashApproval(ctx, "on-failure", "npm install", true);

			expect(result.approved).toBe(true);
			expect(result).toHaveProperty("runUnsandboxed", false);
		});
	});

	describe("policy: on-request", () => {
		it("runs sandboxed when escalate is false", async () => {
			const ctx = createMockContext();
			const result = await checkBashApproval(ctx, "on-request", "curl example.com", false);

			expect(result.approved).toBe(true);
			expect(result).toHaveProperty("runUnsandboxed", false);
			expect(ctx.ui.confirm).not.toHaveBeenCalled();
		});

		it("prompts when escalate is true and user approves", async () => {
			const ctx = createMockContext({ confirmResult: true });
			const result = await checkBashApproval(ctx, "on-request", "curl example.com", true);

			expect(result.approved).toBe(true);
			expect(result).toHaveProperty("runUnsandboxed", true);
			expect(ctx.ui.confirm).toHaveBeenCalled();
		});

		it("denies when escalate is true and user denies", async () => {
			const ctx = createMockContext({ confirmResult: false });
			const result = await checkBashApproval(ctx, "on-request", "curl example.com", true);

			expect(result.approved).toBe(false);
			expect(result).toHaveProperty("reason", "User denied escalation");
		});

		it("denies escalation in headless mode", async () => {
			const ctx = createMockContext({ hasUI: false });
			const result = await checkBashApproval(ctx, "on-request", "curl example.com", true);

			expect(result.approved).toBe(false);
			expect(result).toHaveProperty("reason", "Cannot prompt for escalation in headless mode");
		});
	});

	describe("policy: unless-trusted", () => {
		it("auto-approves safe commands without prompt", async () => {
			const ctx = createMockContext();
			const result = await checkBashApproval(ctx, "unless-trusted", "ls -la", false);

			expect(result.approved).toBe(true);
			expect(result).toHaveProperty("runUnsandboxed", false);
			expect(ctx.ui.confirm).not.toHaveBeenCalled();
		});

		it("prompts for unsafe commands and user approves", async () => {
			const ctx = createMockContext({ confirmResult: true });
			const result = await checkBashApproval(ctx, "unless-trusted", "rm -rf /tmp/test", false);

			expect(result.approved).toBe(true);
			expect(result).toHaveProperty("runUnsandboxed", false);
			expect(ctx.ui.confirm).toHaveBeenCalled();
		});

		it("denies unsafe commands when user denies", async () => {
			const ctx = createMockContext({ confirmResult: false });
			const result = await checkBashApproval(ctx, "unless-trusted", "rm -rf /tmp/test", false);

			expect(result.approved).toBe(false);
			expect(result).toHaveProperty("reason", "User denied command");
		});

		it("denies unsafe commands in headless mode", async () => {
			const ctx = createMockContext({ hasUI: false });
			const result = await checkBashApproval(ctx, "unless-trusted", "rm -rf /tmp/test", false);

			expect(result.approved).toBe(false);
			expect(result).toHaveProperty("reason", "Unsafe command in headless mode");
		});

		it("prompts for escalation when requested and user approves", async () => {
			const ctx = createMockContext({ confirmResult: true });
			const result = await checkBashApproval(ctx, "unless-trusted", "ls -la", true);

			expect(result.approved).toBe(true);
			expect(result).toHaveProperty("runUnsandboxed", true);
			expect(ctx.ui.confirm).toHaveBeenCalled();
		});

		it("denies escalation when user denies", async () => {
			const ctx = createMockContext({ confirmResult: false });
			const result = await checkBashApproval(ctx, "unless-trusted", "ls -la", true);

			expect(result.approved).toBe(false);
			expect(result).toHaveProperty("reason", "User denied escalation");
		});
	});

	describe("unknown policy", () => {
		it("denies with error message", async () => {
			const ctx = createMockContext();
			const result = await checkBashApproval(ctx, "invalid-policy" as ApprovalPolicy, "ls", false);

			expect(result.approved).toBe(false);
			expect(result).toHaveProperty("reason");
			expect((result as any).reason).toContain("Unknown approval policy");
		});
	});
});

describe("checkFilesystemApproval", () => {
	describe("policy: never", () => {
		it("denies without prompt", async () => {
			const ctx = createMockContext();
			const result = await checkFilesystemApproval(ctx, "never", "/etc/passwd", "write");

			expect(result.approved).toBe(false);
			expect(result).toHaveProperty("reason");
			expect((result as any).reason).toContain("never");
			expect(ctx.ui.confirm).not.toHaveBeenCalled();
		});
	});

	describe("policy: on-failure / on-request / unless-trusted", () => {
		const policies: ApprovalPolicy[] = ["on-failure", "on-request", "unless-trusted"];

		for (const policy of policies) {
			it(`${policy}: prompts user and approves when confirmed`, async () => {
				const ctx = createMockContext({ confirmResult: true });
				const result = await checkFilesystemApproval(ctx, policy, "/etc/passwd", "edit");

				expect(result.approved).toBe(true);
				expect(ctx.ui.confirm).toHaveBeenCalled();
			});

			it(`${policy}: denies when user rejects`, async () => {
				const ctx = createMockContext({ confirmResult: false });
				const result = await checkFilesystemApproval(ctx, policy, "/etc/passwd", "edit");

				expect(result.approved).toBe(false);
				expect(result).toHaveProperty("reason", "User denied");
			});

			it(`${policy}: denies in headless mode`, async () => {
				const ctx = createMockContext({ hasUI: false });
				const result = await checkFilesystemApproval(ctx, policy, "/etc/passwd", "write");

				expect(result.approved).toBe(false);
				expect(result).toHaveProperty("reason", "Cannot prompt for approval in headless mode");
			});
		}
	});
});

describe("looksLikePolicyViolation", () => {
	it("detects read-only file system errors", () => {
		expect(looksLikePolicyViolation("error: Read-only file system")).toBe(true);
	});

	it("detects permission denied errors", () => {
		expect(looksLikePolicyViolation("EACCES: permission denied, open '/etc/passwd'")).toBe(true);
	});

	it("detects operation not permitted errors", () => {
		expect(looksLikePolicyViolation("Operation not permitted")).toBe(true);
	});

	it("detects network resolution errors", () => {
		expect(looksLikePolicyViolation("Could not resolve host: example.com")).toBe(true);
	});

	it("detects network unreachable errors", () => {
		expect(looksLikePolicyViolation("Network is unreachable")).toBe(true);
	});

	it("detects connection refused errors", () => {
		expect(looksLikePolicyViolation("Connection refused")).toBe(true);
	});

	it("returns false for regular errors", () => {
		expect(looksLikePolicyViolation("SyntaxError: Unexpected token")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(looksLikePolicyViolation("")).toBe(false);
	});
});

describe("requestApprovalAfterFailure", () => {
	it("prompts user and approves unsandboxed retry when confirmed", async () => {
		const ctx = createMockContext({ confirmResult: true });
		const result = await requestApprovalAfterFailure(
			ctx,
			"npm install",
			"Read-only file system",
		);

		expect(result.approved).toBe(true);
		expect(result).toHaveProperty("runUnsandboxed", true);
		expect(ctx.ui.confirm).toHaveBeenCalled();
	});

	it("denies when user rejects retry", async () => {
		const ctx = createMockContext({ confirmResult: false });
		const result = await requestApprovalAfterFailure(
			ctx,
			"npm install",
			"Read-only file system",
		);

		expect(result.approved).toBe(false);
		expect(result).toHaveProperty("reason", "User denied retry");
	});

	it("denies in headless mode", async () => {
		const ctx = createMockContext({ hasUI: false });
		const result = await requestApprovalAfterFailure(
			ctx,
			"npm install",
			"Read-only file system",
		);

		expect(result.approved).toBe(false);
		expect(result).toHaveProperty("reason", "Cannot prompt in headless mode");
	});

	it("handles long commands by truncating", async () => {
		const ctx = createMockContext({ confirmResult: true });
		const longCommand = "npm install " + "a".repeat(100);
		const result = await requestApprovalAfterFailure(
			ctx,
			longCommand,
			"Permission denied",
		);

		expect(result.approved).toBe(true);
		// Confirm was called with truncated command preview
		expect(ctx.ui.confirm).toHaveBeenCalled();
	});

	it("strips ANSI codes from command and error", async () => {
		const ctx = createMockContext({ confirmResult: true });
		const ansiCommand = "\x1b[31mcolored command\x1b[0m";
		const ansiError = "\x1b[1mBold error\x1b[0m";
		const result = await requestApprovalAfterFailure(ctx, ansiCommand, ansiError);

		expect(result.approved).toBe(true);
	});
});
