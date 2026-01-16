import * as os from "node:os";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Markdown, Text } from "@mariozechner/pi-tui";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ToolRenderResultOptions } from "@mariozechner/pi-coding-agent";
import type { TaskActivity, TaskRunnerUpdateDetails, UsageStats } from "./runner.js";

export type TaskToolDetails = TaskRunnerUpdateDetails & {
	missingSkills?: string[];
	loadedSkills?: Array<{ name: string; path: string }>;
	outputType?: string;
};

function oneLine(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsage(usage: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function formatToolCall(toolName: string, args: Record<string, unknown>, theme: any): string {
	switch (toolName) {
		case "bash": {
			const command = typeof (args as any).command === "string" ? (args as any).command : "...";
			return theme.fg("muted", "$ ") + theme.fg("toolOutput", truncate(oneLine(command), 120));
		}
		case "read": {
			const rawPath = (args as any).path || (args as any).file_path || "...";
			return theme.fg("muted", "read ") + theme.fg("accent", shortenPath(String(rawPath)));
		}
		case "write": {
			const rawPath = (args as any).path || (args as any).file_path || "...";
			return theme.fg("muted", "write ") + theme.fg("accent", shortenPath(String(rawPath)));
		}
		case "edit": {
			const rawPath = (args as any).path || (args as any).file_path || "...";
			return theme.fg("muted", "edit ") + theme.fg("accent", shortenPath(String(rawPath)));
		}
		case "ls": {
			const rawPath = (args as any).path || ".";
			return theme.fg("muted", "ls ") + theme.fg("accent", shortenPath(String(rawPath)));
		}
		case "find": {
			const pat = (args as any).pattern || "*";
			const rawPath = (args as any).path || ".";
			return (
				theme.fg("muted", "find ") +
				theme.fg("accent", String(pat)) +
				theme.fg("dim", ` in ${shortenPath(String(rawPath))}`)
			);
		}
		case "grep": {
			const pat = (args as any).pattern || "";
			const rawPath = (args as any).path || ".";
			return (
				theme.fg("muted", "grep ") +
				theme.fg("accent", `/${String(pat)}/`) +
				theme.fg("dim", ` in ${shortenPath(String(rawPath))}`)
			);
		}
		default:
			return theme.fg("accent", toolName) + theme.fg("dim", ` ${truncate(oneLine(JSON.stringify(args)), 120)}`);
	}
}

function statusMark(status: TaskToolDetails["status"], theme: any): string {
	if (status === "completed") return theme.fg("success", "✔");
	if (status === "failed") return theme.fg("error", "✗");
	if (status === "interrupted") return theme.fg("warning", "!");

	// running
	const blinkOn = Math.floor(Date.now() / 600) % 2 === 0;
	return blinkOn ? theme.fg("muted", "•") : theme.fg("dim", "◦");
}

function activityMark(a: TaskActivity, theme: any): string {
	if (a.status === "success") return theme.fg("success", "✓");
	if (a.status === "error") return theme.fg("error", "✗");
	return theme.fg("dim", "•");
}

/**
 * Hide tool call rendering so task appears as a single cell (like subagent).
 */
export function renderTaskCall(_args: any, _theme: any): Text {
	return new Text("", 0, 0);
}

export function renderTaskResult(
	result: AgentToolResult<TaskToolDetails>,
	options: ToolRenderResultOptions,
	theme: any,
) {
	const details = result.details as TaskToolDetails | undefined;
	if (!details) {
		const first = result.content?.[0];
		const text = first && first.type === "text" ? first.text : "(no details)";
		return new Text(text, 0, 0);
	}

	const header = `${statusMark(details.status, theme)} ${theme.bold("task")} ${theme.fg("accent", `${details.taskType}:${details.difficulty}`)} ${theme.fg("dim", `(session: ${details.sessionId})`)}`;

	const missing = (details.missingSkills || []).filter(Boolean);
	const message = typeof details.message === "string" ? details.message : "";

	if (options.expanded) {
		const mdTheme = getMarkdownTheme();
		const bodyParts: string[] = [];
		bodyParts.push(`# task ${details.taskType}:${details.difficulty}`);
		bodyParts.push("");
		bodyParts.push(`session: ${details.sessionId}`);
		if (details.description) bodyParts.push(`description: ${details.description}`);
		if (details.model) bodyParts.push(`model: ${details.model}`);
		if (missing.length > 0) bodyParts.push(`missing skills: ${missing.join(", ")}`);
		if (details.usage) bodyParts.push(`usage: ${formatUsage(details.usage, details.model)}`);
		bodyParts.push("");
		bodyParts.push(message || "(no output)");
		return new Markdown(bodyParts.join("\n"), 0, 0, mdTheme);
	}

	const lines: string[] = [header];

	if (details.description) {
		lines.push(`  ${theme.fg("dim", "└ ")}${theme.fg("toolOutput", truncate(oneLine(details.description), 140))}`);
	}

	if (missing.length > 0) {
		lines.push(`  ${theme.fg("warning", `missing skills: ${missing.join(", ")}`)}`);
	}

	const activities = details.activities || [];
	const shown = options.isPartial ? activities.slice(0, 8) : activities.slice(0, 3);
	const skipped = Math.max(0, activities.length - shown.length);
	if (skipped > 0) {
		lines.push(`    ${theme.fg("dim", `... +${skipped} more`)}`);
	}

	for (const a of shown) {
		lines.push(`  ${activityMark(a, theme)} ${formatToolCall(a.name, a.args, theme)}`);
	}

	if (message) {
		const summary = options.isPartial ? truncate(oneLine(message), 180) : truncate(oneLine(message), 400);
		lines.push(`  ${theme.fg("dim", "↩ ")}${theme.fg("toolOutput", summary)}`);
	}

	if (details.usage && !options.isPartial) {
		lines.push("");
		lines.push(theme.fg("dim", formatUsage(details.usage, details.model)));
	}

	return new Text(lines.join("\n"), 0, 0);
}
