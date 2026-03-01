import type { ImageContent, TextContent } from "@mariozechner/pi-ai";

/** Minimal message shape for injection functions - content is kept loose to support all message types */
type MessageLike = { role: string; content?: unknown };

import type { SandboxConfig } from "./config.js";

export type PendingSandboxNotice = {
	hash: string;
	text: string;
};

const SANDBOX_NOTICE_PREFIX = /^\s*SANDBOX_(?:STATE|CHANGE):[^\n]*(?:\n\n)?/;

export function computeSandboxConfigHash(cfg: Required<SandboxConfig>): string {
	return [
		`fs=${cfg.filesystemMode}`,
		`net=${cfg.networkMode}`,
		`approval=${cfg.approvalPolicy}`,
		`timeout=${cfg.approvalTimeoutSeconds}`,
		`subagent=${cfg.subagent}`,
	].join(";");
}

function buildSandboxNotice(prefix: "SANDBOX_STATE:" | "SANDBOX_CHANGE:", cfg: Required<SandboxConfig>): string {
	return [
		prefix,
		`fs=${cfg.filesystemMode}`,
		`net=${cfg.networkMode}`,
		`approval=${cfg.approvalPolicy}`,
		`subagent=${cfg.subagent}`,
	].join(" ");
}

export function buildSandboxStateNoticeText(cfg: Required<SandboxConfig>): string {
	return buildSandboxNotice("SANDBOX_STATE:", cfg);
}

export function buildSandboxChangeNoticeText(cfg: Required<SandboxConfig>): string {
	return buildSandboxNotice("SANDBOX_CHANGE:", cfg);
}

function asContentArray(
	content: unknown,
): (TextContent | ImageContent)[] {
	if (content === undefined || content === null) return [];
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (Array.isArray(content)) return content as (TextContent | ImageContent)[];
	return [];
}

function isTextContent(content: TextContent | ImageContent | undefined): content is TextContent {
	return Boolean(content && content.type === "text");
}

function stripSandboxNoticePrefix(text: string): string {
	return text.replace(SANDBOX_NOTICE_PREFIX, "");
}

function stripLeadingSandboxNotice(
	content: (TextContent | ImageContent)[],
): (TextContent | ImageContent)[] {
	if (content.length === 0) return content;

	const first = content[0];
	if (!isTextContent(first)) return content;

	const strippedText = stripSandboxNoticePrefix(first.text);
	if (strippedText === first.text) return content;
	if (strippedText.length === 0) return content.slice(1);

	return [{ ...first, text: strippedText }, ...content.slice(1)];
}

/**
 * Prepend injected notice text as content[0] on the last user message.
 * Returns a new messages array (does not mutate input).
 */
export function injectSandboxNoticeIntoMessages<T extends MessageLike>(
	messages: T[],
	noticeText: string,
): T[] {
	const out = [...messages];

	for (let i = out.length - 1; i >= 0; i--) {
		const msg = out[i];
		if (msg && msg.role === "user") {
			const contentArr = stripLeadingSandboxNotice(asContentArray(msg.content));
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
