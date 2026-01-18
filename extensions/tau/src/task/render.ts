import * as os from "node:os";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Markdown, Text } from "@mariozechner/pi-tui";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ToolRenderResultOptions } from "@mariozechner/pi-coding-agent";
import type { TaskActivity, TaskRunnerUpdateDetails, UsageStats } from "./runner.js";

type NestedTaskInfo = {
	taskType: string;
	complexity: string;
	description?: string;
	sessionId?: string;
	outputPreview?: string;
};

export type TaskBatchItemDetails = {
	index: number;
	type: string;
	complexity: string;
	description?: string;
	sessionId?: string;
	status: TaskRunnerUpdateDetails["status"];
	model?: string;
	usage: UsageStats;
	activities: TaskActivity[];
	message?: string;
	missingSkills?: string[];
	loadedSkills?: Array<{ name: string; path: string }>;
	outputType?: string;
	structuredOutput?: unknown;
	durationMs?: number;
};

export type TaskToolDetails = {
	status: TaskRunnerUpdateDetails["status"];
	results: TaskBatchItemDetails[];
	message?: string;
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

function formatDuration(ms: number | undefined): string | undefined {
	if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return undefined;
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rem = s % 60;
	return `${m}m${String(rem).padStart(2, "0")}s`;
}

function formatUsage(usage: UsageStats, model?: string, durationMs?: number): string {
	const parts: string[] = [];
	const dur = formatDuration(durationMs);
	if (dur) parts.push(dur);
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

function parseNestedTaskInfo(args: Record<string, unknown>, resultText: string | undefined): NestedTaskInfo {
	const tasks = Array.isArray(args["tasks"]) ? (args["tasks"] as Array<{ type?: string; complexity?: string; description?: string }>) : undefined;
	const firstTask = tasks && tasks.length > 0 ? tasks[0] : undefined;

	let taskType = "?";
	let complexity = "medium";
	let description: string | undefined;

	if (tasks && tasks.length > 0) {
		if (tasks.length === 1 && firstTask) {
			taskType = typeof firstTask.type === "string" ? firstTask.type : "?";
			complexity = typeof firstTask.complexity === "string" ? firstTask.complexity : "medium";
			description = typeof firstTask.description === "string" ? firstTask.description : undefined;
		} else {
			taskType = "batch";
			complexity = `${tasks.length}`;
			description = `${tasks.length} tasks`;
		}
	}

	let sessionId: string | undefined;
	let outputPreview: string | undefined;
	if (typeof resultText === "string" && resultText.trim().length > 0) {
		const trimmed = resultText.trim();

		if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
			try {
				const parsed = JSON.parse(trimmed) as unknown;
				if (Array.isArray(parsed)) {
					const counts = { completed: 0, failed: 0, interrupted: 0, running: 0 };
					for (const entry of parsed as Array<{ status?: string }>) {
						const status = typeof entry?.status === "string" ? entry.status : "";
						if (status === "completed") counts.completed++;
						else if (status === "failed") counts.failed++;
						else if (status === "interrupted") counts.interrupted++;
						else if (status === "running") counts.running++;
					}

					const sessionEntry = (parsed as Array<{ session_id?: string }>).find(
						(entry) => entry && typeof entry.session_id === "string" && entry.session_id.length > 0,
					);
					if (sessionEntry) sessionId = sessionEntry.session_id;

					const parts: string[] = [];
					if (counts.completed) parts.push(`${counts.completed} completed`);
					if (counts.failed) parts.push(`${counts.failed} failed`);
					if (counts.interrupted) parts.push(`${counts.interrupted} interrupted`);
					if (counts.running) parts.push(`${counts.running} running`);
					if (parts.length > 0) outputPreview = `results: ${parts.join(", ")}`;
				} else if (parsed && typeof parsed === "object") {
					const parsedSessionId = (parsed as Record<string, unknown>).session_id;
					if (typeof parsedSessionId === "string" && parsedSessionId.length > 0) {
						sessionId = parsedSessionId;
					}
					const parsedMessage = (parsed as Record<string, unknown>).message;
					if (typeof parsedMessage === "string" && parsedMessage.trim().length > 0) {
						outputPreview = oneLine(parsedMessage.trim());
					}
				}
			} catch {
				// ignore parse errors
			}
		}

		if (!outputPreview) {
			const m = trimmed.match(/\bsession_id:\s*([a-f0-9\-]{8,})/i);
			if (m?.[1]) sessionId = m[1];
			outputPreview = oneLine(trimmed.replace(/\n\s*session_id:.*$/is, "").trim());
			if (!outputPreview) outputPreview = oneLine(trimmed);
		}
	}

	return { taskType, complexity, description, sessionId, outputPreview };
}

function formatToolCall(toolName: string, args: Record<string, unknown>, theme: { fg: (key: string, s: string) => string; accent: (s: string) => string; dim: (s: string) => string }): string {
	switch (toolName) {
		case "bash": {
			const command = typeof args["command"] === "string" ? args["command"] : "...";
			return theme.fg("muted", "$ ") + theme.fg("toolOutput", truncate(oneLine(command), 120));
		}
		case "read": {
			const rawPath = args["path"] || args["file_path"] || "...";
			return theme.fg("muted", "read ") + theme.fg("accent", shortenPath(String(rawPath)));
		}
		case "write": {
			const rawPath = args["path"] || args["file_path"] || "...";
			return theme.fg("muted", "write ") + theme.fg("accent", shortenPath(String(rawPath)));
		}
		case "edit": {
			const rawPath = args["path"] || args["file_path"] || "...";
			return theme.fg("muted", "edit ") + theme.fg("accent", shortenPath(String(rawPath)));
		}
		case "ls": {
			const rawPath = args["path"] || ".";
			return theme.fg("muted", "ls ") + theme.fg("accent", shortenPath(String(rawPath)));
		}
		case "find": {
			const pat = args["pattern"] || "*";
			const rawPath = args["path"] || ".";
			return (
				theme.fg("muted", "find ") +
				theme.fg("accent", String(pat)) +
				theme.fg("dim", ` in ${shortenPath(String(rawPath))}`)
			);
		}
		case "grep": {
			const pat = args["pattern"] || "";
			const rawPath = args["path"] || ".";
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

function summarizeBatchResults(results: TaskBatchItemDetails[]): string {
	const total = results.length;
	const counts = { completed: 0, failed: 0, interrupted: 0, running: 0 };
	for (const result of results) {
		counts[result.status]++;
	}
	const parts: string[] = [];
	if (counts.completed) parts.push(`${counts.completed} completed`);
	if (counts.failed) parts.push(`${counts.failed} failed`);
	if (counts.interrupted) parts.push(`${counts.interrupted} interrupted`);
	if (counts.running) parts.push(`${counts.running} running`);
	return parts.length > 0 ? `${parts.join(", ")} of ${total}` : `0 of ${total}`;
}

/**
 * Hide tool call rendering so task appears as a single cell (like subagent).
 */
export function renderTaskCall(_args: unknown, _theme: unknown): Text {
	return new Text("", 0, 0);
}

export function renderTaskResult(
	result: AgentToolResult<TaskToolDetails>,
	options: ToolRenderResultOptions,
	theme: { fg: (key: string, s: string) => string; bold: (s: string) => string; accent: (s: string) => string; dim: (s: string) => string; warning: (s: string) => string; error: (s: string) => string; success: (s: string) => string },
) {
	const details = result.details as TaskToolDetails | undefined;
	if (!details) {
		const first = result.content?.[0];
		const text = first && first.type === "text" ? first.text : "(no details)";
		return new Text(text, 0, 0);
	}

	const maybeResults = details.results;
	if (!Array.isArray(maybeResults)) {
		const legacy = details as unknown as TaskBatchItemDetails & { taskType: string; sessionId: string };
		const header = `${statusMark(legacy.status, theme)} ${theme.bold("task")} ${theme.fg("accent", `${legacy.taskType}:${legacy.complexity}`)} ${theme.fg("dim", `(session: ${legacy.sessionId})`)}`;

		const missing = (legacy.missingSkills || []).filter(Boolean);
		const message = typeof legacy.message === "string" ? legacy.message : "";

		if (options.expanded) {
			const mdTheme = getMarkdownTheme();
			const bodyParts: string[] = [];
			bodyParts.push(`# task ${legacy.taskType}:${legacy.complexity}`);
			bodyParts.push("");
			bodyParts.push(`session: ${legacy.sessionId}`);
			if (legacy.description) bodyParts.push(`description: ${legacy.description}`);
			if (legacy.model) bodyParts.push(`model: ${legacy.model}`);
			if (missing.length > 0) bodyParts.push(`missing skills: ${missing.join(", ")}`);
			if (legacy.usage) bodyParts.push(`usage: ${formatUsage(legacy.usage, legacy.model, legacy.durationMs)}`);
			bodyParts.push("");
			bodyParts.push(message || "(no output)");
			return new Markdown(bodyParts.join("\n"), 0, 0, mdTheme);
		}

		const lines: string[] = [header];

		if (legacy.description) {
			lines.push(`  ${theme.fg("dim", "└ ")}${theme.fg("toolOutput", truncate(oneLine(legacy.description), 140))}`);
		}

		if (missing.length > 0) {
			lines.push(`  ${theme.fg("warning", `missing skills: ${missing.join(", ")}`)}`);
		}

		const activities = legacy.activities || [];
		const shown = options.isPartial ? activities.slice(0, 8) : activities.slice(0, 3);
		const skipped = Math.max(0, activities.length - shown.length);
		if (skipped > 0) {
			lines.push(`    ${theme.fg("dim", `... +${skipped} more`)}`);
		}

		for (const a of shown) {
			if (a.name === "task") {
				const info = parseNestedTaskInfo(a.args, a.resultText);
				let nested = `${activityMark(a, theme)} ${theme.fg("muted", "task ")}${theme.fg("accent", `${info.taskType}:${info.complexity}`)}`;
				if (info.sessionId) nested += theme.fg("dim", ` (session: ${info.sessionId})`);
				lines.push(`  ${nested}`);
				if (info.description) {
					lines.push(`    ${theme.fg("dim", "└ ")}${theme.fg("toolOutput", truncate(oneLine(info.description), 140))}`);
				}
				if (info.outputPreview) {
					lines.push(`    ${theme.fg("dim", "↩ ")}${theme.fg("toolOutput", truncate(info.outputPreview, 180))}`);
				}
				continue;
			}

			lines.push(`  ${activityMark(a, theme)} ${formatToolCall(a.name, a.args, theme)}`);
		}

		if (message) {
			const summary = options.isPartial ? truncate(oneLine(message), 180) : truncate(oneLine(message), 400);
			lines.push(`  ${theme.fg("dim", "↩ ")}${theme.fg("toolOutput", summary)}`);
		}

		if (legacy.usage && !options.isPartial) {
			lines.push("");
			lines.push(theme.fg("dim", formatUsage(legacy.usage, legacy.model, legacy.durationMs)));
		}

		return new Text(lines.join("\n"), 0, 0);
	}

	const results = maybeResults as TaskBatchItemDetails[];
	const summary = summarizeBatchResults(results);
	const header = `${statusMark(details.status, theme)} ${theme.bold("task")} ${theme.fg("accent", `batch:${results.length}`)}`;

	if (options.expanded) {
		const mdTheme = getMarkdownTheme();
		const bodyParts: string[] = [];
		bodyParts.push(`# task batch (${results.length})`);
		if (summary) bodyParts.push(`status: ${summary}`);
		bodyParts.push("");

		for (const item of results) {
			const missing = (item.missingSkills || []).filter(Boolean);
			bodyParts.push(`## [${item.index}] ${item.type}:${item.complexity}`);
			bodyParts.push(`status: ${item.status}`);
			if (item.sessionId) bodyParts.push(`session: ${item.sessionId}`);
			if (item.description) bodyParts.push(`description: ${item.description}`);
			if (item.model) bodyParts.push(`model: ${item.model}`);
			if (missing.length > 0) bodyParts.push(`missing skills: ${missing.join(", ")}`);
			if (item.usage) bodyParts.push(`usage: ${formatUsage(item.usage, item.model, item.durationMs)}`);
			bodyParts.push("");
			bodyParts.push(item.message || "(no output)");
			bodyParts.push("");
		}

		return new Markdown(bodyParts.join("\n"), 0, 0, mdTheme);
	}

	const lines: string[] = [header];
	if (summary) {
		lines.push(`  ${theme.fg("dim", summary)}`);
	}

	const shown = options.isPartial ? results.slice(0, 3) : results.slice(0, 5);
	const skipped = Math.max(0, results.length - shown.length);

	for (const item of shown) {
		const missing = (item.missingSkills || []).filter(Boolean);
		let line = `${statusMark(item.status, theme)} ${theme.fg("accent", `${item.type}:${item.complexity}`)}`;
		if (item.sessionId) line += theme.fg("dim", ` (session: ${item.sessionId})`);
		lines.push(`  ${line}`);

		if (item.description) {
			lines.push(`    ${theme.fg("dim", "└ ")}${theme.fg("toolOutput", truncate(oneLine(item.description), 140))}`);
		}

		if (missing.length > 0) {
			lines.push(`    ${theme.fg("warning", `missing skills: ${missing.join(", ")}`)}`);
		}

		const activities = item.activities || [];
		const shownActivities = options.isPartial ? activities.slice(0, 2) : activities.slice(0, 3);
		const skippedActivities = Math.max(0, activities.length - shownActivities.length);
		if (skippedActivities > 0) {
			lines.push(`    ${theme.fg("dim", `... +${skippedActivities} more`)}`);
		}

		for (const activity of shownActivities) {
			if (activity.name === "task") {
				const info = parseNestedTaskInfo(activity.args, activity.resultText);
				let nested = `${activityMark(activity, theme)} ${theme.fg("muted", "task ")}${theme.fg("accent", `${info.taskType}:${info.complexity}`)}`;
				if (info.sessionId) nested += theme.fg("dim", ` (session: ${info.sessionId})`);
				lines.push(`    ${nested}`);
				if (info.description) {
					lines.push(`      ${theme.fg("dim", "└ ")}${theme.fg("toolOutput", truncate(oneLine(info.description), 140))}`);
				}
				if (info.outputPreview) {
					lines.push(`      ${theme.fg("dim", "↩ ")}${theme.fg("toolOutput", truncate(info.outputPreview, 180))}`);
				}
				continue;
			}

			lines.push(`    ${activityMark(activity, theme)} ${formatToolCall(activity.name, activity.args, theme)}`);
		}

		if (item.message) {
			const itemSummary = options.isPartial
				? truncate(oneLine(item.message), 160)
				: truncate(oneLine(item.message), 320);
			lines.push(`    ${theme.fg("dim", "↩ ")}${theme.fg("toolOutput", itemSummary)}`);
		}
	}

	if (skipped > 0) {
		lines.push(`  ${theme.fg("dim", `... +${skipped} more`)}`);
	}

	return new Text(lines.join("\n"), 0, 0);
}
