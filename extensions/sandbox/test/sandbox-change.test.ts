import { describe, expect, it } from "vitest";

import {
	buildSandboxChangeNoticeText,
	buildSandboxStateNoticeText,
	computeSandboxConfigHash,
	injectSandboxNoticeIntoMessages,
} from "../src/sandbox-change.js";

describe("sandbox-change", () => {
	it("computes stable hash independent of allowlist ordering", () => {
		const a: any = {
			filesystemMode: "workspace-write",
			networkMode: "allowlist",
			networkAllowlist: ["b.com", "a.com"],
			approvalPolicy: "on-failure",
			approvalTimeoutSeconds: 60,
		};
		const b: any = { ...a, networkAllowlist: ["a.com", "b.com"] };
		expect(computeSandboxConfigHash(a)).toBe(computeSandboxConfigHash(b));
	});

	it("formats SANDBOX_CHANGE notice", () => {
		const cfg: any = {
			filesystemMode: "read-only",
			networkMode: "deny",
			networkAllowlist: [],
			approvalPolicy: "never",
			approvalTimeoutSeconds: 60,
		};
		expect(buildSandboxChangeNoticeText(cfg)).toContain("SANDBOX_CHANGE:");
		expect(buildSandboxChangeNoticeText(cfg)).toContain("fs=read-only");
		expect(buildSandboxChangeNoticeText(cfg)).toContain("net=deny");
	});

	it("formats SANDBOX_STATE notice", () => {
		const cfg: any = {
			filesystemMode: "workspace-write",
			networkMode: "allow-all",
			networkAllowlist: [],
			approvalPolicy: "on-failure",
			approvalTimeoutSeconds: 60,
		};
		expect(buildSandboxStateNoticeText(cfg)).toContain("SANDBOX_STATE:");
		expect(buildSandboxStateNoticeText(cfg)).toContain("fs=workspace-write");
	});

	it("injects notice as user content[0]", () => {
		const messages: any[] = [
			{ role: "assistant", content: [{ type: "text", text: "hi" }] },
			{ role: "user", content: [{ type: "text", text: "do thing" }] },
		];

		const out = injectSandboxNoticeIntoMessages(messages, "SANDBOX_CHANGE: fs=workspace-write");
		expect(out).not.toBe(messages);
		const user = out[1];
		expect(user.content[0].type).toBe("text");
		expect(user.content[0].text).toContain("SANDBOX_CHANGE:");
		expect(user.content[1].text).toBe("do thing");
	});

	it("does not double-inject if content[0] already has SANDBOX_CHANGE", () => {
		const messages: any[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "SANDBOX_CHANGE: fs=read-only\n\n" },
					{ type: "text", text: "do thing" },
				],
			},
		];
		const out = injectSandboxNoticeIntoMessages(messages, "SANDBOX_CHANGE: fs=workspace-write");
		expect(out[0].content[0].text).toContain("fs=read-only");
	});

	it("does not double-inject if content[0] already has SANDBOX_STATE", () => {
		const messages: any[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "SANDBOX_STATE: fs=read-only\n\n" },
					{ type: "text", text: "do thing" },
				],
			},
		];
		const out = injectSandboxNoticeIntoMessages(messages, "SANDBOX_CHANGE: fs=workspace-write");
		expect(out[0].content[0].text).toContain("SANDBOX_STATE:");
	});
});
