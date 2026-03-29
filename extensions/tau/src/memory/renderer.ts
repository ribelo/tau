import { getMarkdownTheme, type Theme } from "@mariozechner/pi-coding-agent";
import { Markdown, Text } from "@mariozechner/pi-tui";

import type {
	MemoryBucketEntriesSnapshot,
	MemoryBucketSnapshot,
	MemoryEntriesSnapshot,
	MemoryEntry,
	MemoryScope,
} from "./format.js";

export type MemoryToolAction = "add" | "update" | "remove";

export type MemoryToolDetails = {
	readonly success: boolean;
	readonly action?: MemoryToolAction;
	readonly scope?: MemoryScope;
	readonly entry?: MemoryEntry;
	readonly bucket?: MemoryBucketSnapshot;
};

export type MemoriesMessageDetails = {
	readonly snapshot: MemoryEntriesSnapshot;
};

type MemoryToolResult = {
	readonly content?: readonly { readonly type: string; readonly text?: string }[];
	readonly details?: unknown;
};

const SEPARATOR =
	"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";

function firstTextContent(result: MemoryToolResult): string {
	const text = result.content?.find((item) => item.type === "text");
	return text?.text ?? "";
}

function previewContent(value: string, maxChars = 96): string {
	const normalized = value.replace(/\s+/gu, " ").trim();
	if (normalized.length <= maxChars) {
		return normalized;
	}
	return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function renderCallContent(value: string, theme: Theme): string {
	const lines = value.replace(/\r\n?/gu, "\n").split("\n");
	return [`${theme.fg("muted", "content:")}`, ...lines.map((line) => `  ${theme.fg("toolOutput", line)}`)].join("\n");
}

function renderProgressBar(percent: number | undefined, width: number, theme: Theme): string {
	if (typeof percent !== "number") {
		return `${theme.fg("muted", "[")}${theme.fg("dim", "?".repeat(width))}${theme.fg("muted", "]")}`;
	}

	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * width);
	const empty = Math.max(0, width - filled);
	const tone = clamped >= 90 ? "error" : clamped >= 75 ? "warning" : "success";

	return [
		theme.fg("muted", "["),
		theme.fg(tone, "█".repeat(filled)),
		theme.fg("dim", "░".repeat(empty)),
		theme.fg("muted", "]"),
	].join("");
}

function actionLabel(action: MemoryToolAction | undefined): string {
	switch (action) {
		case "add":
			return "memory add";
		case "update":
			return "memory update";
		case "remove":
			return "memory remove";
		default:
			return "memory";
	}
}

function scopeText(scope: MemoryScope | undefined, theme: Theme): string {
	if (!scope) {
		return theme.fg("dim", "unknown");
	}

	const tone = scope === "user" ? "warning" : scope === "global" ? "success" : "accent";
	return theme.fg(tone, scope);
}

function scopeColumn(scope: MemoryScope, theme: Theme): string {
	if (scope === "user") {
		return theme.fg("warning", scope.padEnd(7));
	}
	if (scope === "global") {
		return theme.fg("success", scope.padEnd(7));
	}
	return theme.fg("accent", scope.padEnd(7));
}

function renderBucketSummary(bucket: MemoryBucketEntriesSnapshot, theme: Theme): string {
	return [
		`  ${theme.fg("muted", `${bucket.bucket.padEnd(8)}:`)}`,
		renderProgressBar(bucket.usagePercent, 14, theme),
		theme.fg("toolOutput", `${bucket.entries.length} entries`),
		theme.fg("dim", `· ${bucket.chars}/${bucket.limitChars} chars`),
	].join(" ");
}

function flattenEntries(snapshot: MemoryEntriesSnapshot): ReadonlyArray<{
	readonly scope: MemoryScope;
	readonly entry: MemoryEntry;
}> {
	return [snapshot.project, snapshot.global, snapshot.user].flatMap((bucket) =>
		bucket.entries.map((entry) => ({ scope: bucket.bucket, entry })),
	);
}

export function renderMemoriesMessage(details: MemoriesMessageDetails, theme: Theme): Text {
	const buckets = [details.snapshot.project, details.snapshot.global, details.snapshot.user] as const;
	const entries = flattenEntries(details.snapshot);
	const out: string[] = [theme.fg("dim", SEPARATOR)];

	out.push(`\n${theme.fg("toolTitle", theme.bold("memories"))}`);
	for (const bucket of buckets) {
		out.push(`\n${renderBucketSummary(bucket, theme)}`);
	}

	out.push(
		`\n\n  ${theme.fg("dim", "id".padEnd(21))}  ${theme.fg("dim", "size".padStart(9))}  ${theme.fg("dim", "scope".padEnd(7))}  ${theme.fg("dim", "preview")}`,
	);

	if (entries.length === 0) {
		out.push(`\n  ${theme.fg("muted", "No saved memories.")}`);
		return new Text(out.join(""), 0, 0);
	}

	for (const { scope, entry } of entries) {
		const size = `${entry.content.length} chars`.padStart(9);
		out.push(
			`\n  ${theme.fg("accent", entry.id)}  ${theme.fg("muted", size)}  ${scopeColumn(scope, theme)}  ${theme.fg("toolOutput", previewContent(entry.content, 88))}`,
		);
	}

	return new Text(out.join(""), 0, 0);
}

function renderSuccess(details: MemoryToolDetails, message: string, theme: Theme): Text {
	const entry = details.entry;
	const bucket = details.bucket;
	const out: string[] = [theme.fg("dim", SEPARATOR)];

	out.push(`\n${theme.fg("success", "✔")} ${theme.fg("toolTitle", theme.bold(actionLabel(details.action)))}`);
	if (message) {
		out.push(`\n${theme.fg("muted", message.split("\n")[0] ?? message)}`);
	}

	if (entry) {
		out.push(`\n  ${theme.fg("muted", "id".padEnd(8))}: ${theme.fg("accent", entry.id)}`);
		out.push(`\n  ${theme.fg("muted", "scope".padEnd(8))}: ${scopeText(details.scope, theme)}`);
		out.push(
			`\n  ${theme.fg("muted", "size".padEnd(8))}: ${theme.fg("toolOutput", `${entry.content.length} chars`)}`,
		);
		out.push(
			`\n  ${theme.fg("muted", "preview".padEnd(8))}: ${theme.fg("toolOutput", previewContent(entry.content))}`,
		);
	}

	if (bucket) {
		const percent = typeof bucket.usagePercent === "number" ? bucket.usagePercent : undefined;
		out.push(
			`\n  ${theme.fg("muted", "usage".padEnd(8))}: ${renderProgressBar(percent, 20, theme)} ${theme.fg(
				"toolOutput",
				typeof percent === "number" ? `${percent}%` : "unknown",
			)}`,
		);
		out.push(
			`\n  ${theme.fg("muted", "bucket".padEnd(8))}: ${theme.fg("toolOutput", `${bucket.entries.length} entries`)} ${theme.fg("dim", `· limit ${bucket.limitChars} chars`)}`,
		);
	}

	return new Text(out.join(""), 0, 0);
}

function renderFailure(message: string, theme: Theme): Text {
	let out = theme.fg("dim", SEPARATOR);
	out += `\n${theme.fg("error", "✘")} ${theme.fg("toolTitle", theme.bold("memory"))}`;
	out += `\n${theme.fg("error", message || "Memory operation failed")}`;
	return new Text(out, 0, 0);
}

export function renderMemoryCall(args: Record<string, unknown> | undefined, theme: Theme): Text {
	const action = typeof args?.["action"] === "string" ? args["action"] : "memory";
	const scope = typeof args?.["target"] === "string" ? args["target"] : undefined;
	const id = typeof args?.["id"] === "string" ? args["id"].trim() : "";
	const content = typeof args?.["content"] === "string" ? args["content"].trim() : "";

	let out = theme.fg("toolTitle", theme.bold(`memory ${action}`));
	if (scope) {
		out += `\n${theme.fg("muted", `scope: ${scope}`)}`;
	}
	if (id) {
		out += `\n${theme.fg("muted", `id: ${id}`)}`;
	}
	if (content) {
		out += `\n${theme.fg("muted", `chars: ${content.length}`)}`;
		out += `\n${renderCallContent(content, theme)}`;
	}

	return new Text(out, 0, 0);
}

export function renderMemoryResult(result: MemoryToolResult, theme: Theme) {
	const details = result.details as MemoryToolDetails | undefined;
	const message = firstTextContent(result);

	if (!details) {
		return new Markdown(message, 0, 0, getMarkdownTheme());
	}

	if (!details.success) {
		return renderFailure(message, theme);
	}

	if (!details.entry && !details.bucket) {
		return new Markdown(message, 0, 0, getMarkdownTheme());
	}

	return renderSuccess(details, message, theme);
}
