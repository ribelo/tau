import type { ImageContent, Message, TextContent } from "@mariozechner/pi-ai";

import type { SandboxConfig } from "./config.js";

export type PendingSandboxNotice = {
	hash: string;
	text: string;
};

export function computeSandboxConfigHash(cfg: Required<SandboxConfig>): string {
	return [
		`fs=${cfg.filesystemMode}`,
		`net=${cfg.networkMode}`,
		`approval=${cfg.approvalPolicy}`,
		`timeout=${cfg.approvalTimeoutSeconds}`,
	].join(";");
}

// This is the clean version of the notice builder. No allowlist here!
function buildSandboxNotice(prefix: "SANDBOX_STATE:" | "SANDBOX_CHANGE:", cfg: Required<SandboxConfig>): string {
	return [
		prefix,
		`fs=${cfg.filesystemMode}`,
		`net=${cfg.networkMode}`,
		`approval=${cfg.approvalPolicy}`,
	].join(" ");
}

export function buildSandboxStateNoticeText(cfg: Required<SandboxConfig>): string {
	return buildSandboxNotice("SANDBOX_STATE:", cfg);
}

export function buildSandboxChangeNoticeText(cfg: Required<SandboxConfig>): string {
	return buildSandboxNotice("SANDBOX_CHANGE:", cfg);
}

function asContentArray(
	content: string | (TextContent | ImageContent)[] | undefined,
): (TextContent | ImageContent)[] {
	if (content === undefined) return [];
	if (typeof content === "string") return [{ type: "text", text: content }];
	return content;
}

/**
 * Prepend injected notice text as content[0] on the last user message.
 * Returns a new messages array (does not mutate input).
 */
export function injectSandboxNoticeIntoMessages<T extends Message>(
	messages: T[],
	noticeText: string,
): T[] {
	const out = [...messages];

	for (let i = out.length - 1; i >= 0; i--) {
		const msg = out[i];
		if (msg && msg.role === "user") {
			const contentArr = asContentArray(msg.content);
			const firstText =
				contentArr[0] && contentArr[0].type === "text" ? (contentArr[0] as TextContent).text : "";
			if (
				firstText.trimStart().startsWith("SANDBOX_CHANGE:") ||
				firstText.trimStart().startsWith("SANDBOX_STATE:")
			) {
				return out;
			}

			const injected: TextContent = { type: "text", text: `${noticeText}\n\n` };
			out[i] = {
				...msg,
				content: [injected, ...contentArr],
			};
			return out;
		}
	}

	return out;
}
