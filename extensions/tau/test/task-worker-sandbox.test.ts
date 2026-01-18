import { describe, expect, it } from "vitest";

import { checkBashApproval, checkFilesystemApproval, requestApprovalAfterFailure } from "../src/sandbox/approval.js";
import { computeClampedWorkerSandboxConfig } from "../src/task/sandbox-policy.js";
import { withWorkerSandboxOverride } from "../src/task/worker-sandbox.js";

describe("task worker sandbox/approval", () => {
	it("policy clamping: worker cannot exceed parent", () => {
		const parent = {
			filesystemMode: "read-only",
			networkMode: "allowlist",
			networkAllowlist: ["a.com"],
			approvalPolicy: "unless-trusted",
			approvalTimeoutSeconds: 30,
		} as const;

		const out = computeClampedWorkerSandboxConfig({
			parent,
			requested: {
				filesystemMode: "danger-full-access",
				networkMode: "allow-all",
				networkAllowlist: ["a.com", "b.com"],
				approvalPolicy: "on-failure",
				approvalTimeoutSeconds: 120,
			},
		});

		expect(out.filesystemMode).toBe("read-only");
		expect(out.networkMode).toBe("allowlist");
		expect(out.networkAllowlist).toEqual(["a.com"]);
		expect(out.approvalPolicy).toBe("unless-trusted");
		expect(out.approvalTimeoutSeconds).toBe(30);
	});

	it("re-snapshot: overwrites tau:state sandbox override each call", () => {
		const base = {
			sandbox: {
				systemPromptInjected: true,
				override: {
					filesystemMode: "danger-full-access",
					networkMode: "allow-all",
					networkAllowlist: [],
					approvalPolicy: "on-failure",
					approvalTimeoutSeconds: 60,
				},
			},
		} as any;

		const first = withWorkerSandboxOverride(base, {
			filesystemMode: "workspace-write",
			networkMode: "allow-all",
			networkAllowlist: [],
			approvalPolicy: "on-request",
			approvalTimeoutSeconds: 60,
		});

		const second = withWorkerSandboxOverride(first, {
			filesystemMode: "read-only",
			networkMode: "deny",
			networkAllowlist: [],
			approvalPolicy: "never",
			approvalTimeoutSeconds: 10,
		});

		expect((second as any).sandbox.systemPromptInjected).toBe(true);
		expect((second as any).sandbox.override.filesystemMode).toBe("read-only");
		expect((second as any).sandbox.override.networkMode).toBe("deny");
		expect((second as any).sandbox.override.approvalPolicy).toBe("never");
	});

	it("approval broker: headless worker can prompt via broker", async () => {
		const headlessCtx = { hasUI: false, ui: { confirm: async () => false } } as any;

		const broker = {
			confirm: async () => true,
		};

		const bash = await checkBashApproval(headlessCtx, "on-request", "rm -rf /", true, { timeoutSeconds: 1 }, broker);
		expect(bash).toEqual({ approved: true, runUnsandboxed: true });

		const fs = await checkFilesystemApproval(
			headlessCtx,
			"on-request",
			"/etc/passwd",
			"write",
			{ timeoutSeconds: 1 },
			broker,
		);
		expect(fs.approved).toBe(true);

		const retry = await requestApprovalAfterFailure(
			headlessCtx,
			"curl https://example.com",
			"Could not resolve host",
			{ timeoutSeconds: 1 },
			broker,
		);
		expect(retry).toEqual({ approved: true, runUnsandboxed: true });
	});

	it("approval broker: headless worker denies without broker", async () => {
		const headlessCtx = { hasUI: false, ui: { confirm: async () => true } } as any;
		const res = await checkBashApproval(headlessCtx, "on-request", "rm -rf /", true, { timeoutSeconds: 1 });
		expect(res.approved).toBe(false);
	});
});

