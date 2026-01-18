import { describe, expect, it } from "vitest";

import { computeClampedWorkerSandboxConfig } from "../src/task/sandbox-policy.js";

describe("task sandbox policy", () => {
	it("clamps filesystem modes to parent", () => {
		const parent = {
			filesystemMode: "read-only",
			networkMode: "allow-all",
			networkAllowlist: [],
			approvalPolicy: "on-failure",
			approvalTimeoutSeconds: 60,
		} as const;

		expect(
			computeClampedWorkerSandboxConfig({
				parent,
				requested: { filesystemMode: "danger-full-access" },
			}).filesystemMode,
		).toBe("read-only");
	});

	it("clamps network modes and allowlist subsets", () => {
		const parent = {
			filesystemMode: "workspace-write",
			networkMode: "allowlist",
			networkAllowlist: ["a.com", "b.com"],
			approvalPolicy: "on-request",
			approvalTimeoutSeconds: 60,
		} as const;

		const out = computeClampedWorkerSandboxConfig({
			parent,
			requested: { networkMode: "allow-all", networkAllowlist: ["b.com", "c.com"] },
		});

		expect(out.networkMode).toBe("allowlist");
		expect(out.networkAllowlist).toEqual(["b.com"]);
	});

	it("clamps approval policy and timeout", () => {
		const parent = {
			filesystemMode: "danger-full-access",
			networkMode: "allow-all",
			networkAllowlist: [],
			approvalPolicy: "on-request",
			approvalTimeoutSeconds: 30,
		} as const;

		const out = computeClampedWorkerSandboxConfig({
			parent,
			requested: { approvalPolicy: "on-failure", approvalTimeoutSeconds: 120 },
		});

		expect(out.approvalPolicy).toBe("on-request");
		expect(out.approvalTimeoutSeconds).toBe(30);
	});
});

