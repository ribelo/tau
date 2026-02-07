import { Text } from "@mariozechner/pi-tui";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ToolRenderResultOptions, Theme } from "@mariozechner/pi-coding-agent";
import { formatDuration } from "./status.js";

function oneLine(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

function statusMark(state: string, theme: Theme): string {
	if (state === "completed" || state === "shutdown")
		return theme.fg("success", "✔");
	if (state === "failed") return theme.fg("error", "✘");
	if (state === "running") {
		return theme.fg("accent", "●");
	}
	return theme.fg("dim", "◦");
}

export function renderAgentCall(args: unknown, theme: Theme) {
	const params = args as Record<string, unknown>;
	const action = params["action"] as string;

	switch (action) {
		case "spawn": {
			const agent = params["agent"] as string || "?";
			const msg = params["message"] as string || "";
			const preview = truncate(oneLine(msg), 60);
			return new Text(
				`${theme.fg("dim", "⌬")} ${theme.fg("accent", `spawn:${agent}`)} ${theme.fg("dim", `"${preview}"`)}`,
				0, 0,
			);
		}
		case "wait": {
			const ids = params["ids"] as string[] || [];
			const header = ids.length === 0
				? "waiting"
				: ids.length === 1
					? "waiting for 1 agent"
					: `waiting for ${ids.length} agents`;
			return new Text(
				`${theme.fg("dim", "◷")} ${theme.fg("accent", header)}`,
				0, 0,
			);
		}
		case "send": {
			const id = params["id"] as string || "?";
			const msg = params["message"] as string || "";
			const preview = truncate(oneLine(msg), 40);
			return new Text(
				`${theme.fg("dim", "➜")} ${theme.fg("accent", `send:${id.slice(0, 8)}`)} ${theme.fg("dim", `"${preview}"`)}`,
				0, 0,
			);
		}
		case "close": {
			const id = params["id"] as string || "?";
			return new Text(
				`${theme.fg("dim", "✕")} ${theme.fg("accent", `close:${id.slice(0, 8)}`)}`,
				0, 0,
			);
		}
		case "list": {
			return new Text(
				`${theme.fg("dim", "≣")} ${theme.fg("accent", "list")}`,
				0, 0,
			);
		}
		default:
			return new Text(`${theme.fg("dim", "⋯")} agent:${action || "?"}`, 0, 0);
	}
}

export function renderAgentResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
) {
	if (typeof result === "object" && result !== null && "isError" in result && result.isError) {
		const first = result.content?.[0];
		const text = first && first.type === "text" ? first.text : "(error)";
		return new Text(theme.fg("error", `✘ error: ${text}`), 0, 0);
	}

	const data = (result.details || result) as Record<string, unknown>;

	// Helper to render tool history
	const renderTools = (tools: Array<{ name: string; args?: string; result?: string; isError?: boolean }>) => {
		if (tools.length === 0) return "";
		const lines = tools.map(t => {
			const mark = t.isError ? theme.fg("error", "✘") : theme.fg("dim", "·");
			const name = theme.fg("accent", t.name);
			const args = t.args ? theme.fg("dim", ` ${truncate(t.args, 80).replace(/ /g, "\u00A0")}`) : "";
			return `      ${mark} ${name}${args}`;
		});
		return "\n" + lines.join("\n");
	};

	// Helper to render a single agent status line
	const renderAgentLine = (id: string, type: string, status: Record<string, unknown>, expanded: boolean) => {
		const state = (status["state"] as string) || "unknown";
		const workedMs = status["workedMs"] as number | undefined;
		const tools = status["tools"] as Array<{ name: string; args?: string; result?: string; isError?: boolean }> | undefined;
		const idStr = id.slice(0, 8);
		const typeStr = type ? `  ${theme.fg("accent", type)}` : "";
		const workedStr = workedMs !== undefined && workedMs > 0
			? `  ${theme.fg("accent", "●")} ${theme.fg("dim", formatDuration(workedMs))}`
			: "";

		let line = `  ${statusMark(state, theme)} ${theme.fg("accent", idStr)}${typeStr}${workedStr}`;

		if (expanded && status["message"]) {
			line += `\n    ${theme.fg("dim", "↩ ")}${theme.fg("toolOutput", truncate(oneLine(status["message"] as string), 140))}`;
		}
		if (status["reason"]) {
			line += `\n    ${theme.fg("error", `✘ ${status["reason"]}`)}`;
		}
		// Show tool history when expanded
		if (expanded && tools && tools.length > 0) {
			line += `\n    ${theme.fg("dim", `${tools.length} tools:`)}${renderTools(tools)}`;
		}
		return line;
	};

	// spawn
	if (data["agent_id"] && data["status"] === "running") {
		const idStr = (data["agent_id"] as string).slice(0, 8);
		const msg = data["message"] as string | undefined;
		if (options.expanded && msg) {
			return new Text(
				`${theme.fg("success", "✔")} ${theme.fg("accent", idStr)} ${theme.fg("dim", "(running)")}\n${theme.fg("dim", "task:")} ${msg}`,
				0,
				0,
			);
		}
		return new Text(
			`${theme.fg("success", "✔")} ${theme.fg("accent", idStr)} ${theme.fg("dim", "(running)")}`,
			0,
			0,
		);
	}

	// send
	if (data["submission_id"]) {
		return new Text(
			`${theme.fg("success", "✔")} submission: ${theme.fg("dim", (data["submission_id"] as string).slice(0, 8))}`,
			0,
			0,
		);
	}

	// close
	if (data["status"] === "closed") {
		return new Text(`${theme.fg("success", "✔")} shutdown`, 0, 0);
	}

	// list
	if (Array.isArray(data["agents"])) {
		const agents = data["agents"] as Array<{ id: string; type: string; status: Record<string, unknown> }>;
		// Sort: running agents at the bottom, then by id for stability
		const sortedAgents = [...agents].sort((a, b) => {
			const aRunning = a.status["state"] === "running" ? 1 : 0;
			const bRunning = b.status["state"] === "running" ? 1 : 0;
			if (aRunning !== bRunning) return aRunning - bRunning;
			return a.id.localeCompare(b.id);
		});
		const lines = [];
		for (const a of sortedAgents) {
			lines.push(renderAgentLine(a.id, a.type, a.status, options.expanded));
		}
		return new Text(lines.join("\n"), 0, 0);
	}

	// wait
	if (data["status"] && typeof data["status"] === "object") {
		const statusMap = data["status"] as Record<string, Record<string, unknown>>;
		const agentTypes = data["agentTypes"] as Record<string, string> | undefined;
		const ids = Object.keys(statusMap);
		const timedOut = data["timedOut"] as boolean | undefined;
		const interrupted = data["interrupted"] as boolean | undefined;
		const lines: string[] = [];
		
		// Show message for no agents
		if (ids.length === 0) {
			return new Text(theme.fg("dim", "No active agents to wait for. Use 'spawn' to create agents first, or 'list' to see existing agents."), 0, 0);
		}
		
		// Show interruption warning if applicable
		if (interrupted) {
			lines.push(theme.fg("warning", "⚠ Interrupted (agents still running in background)"));
		}
		
		// Show timeout warning if applicable
		if (timedOut) {
			lines.push(theme.fg("warning", "⚠ Timed out waiting for agents"));
		}
		
		// Sort: running agents at the bottom, then by id for stability
		const sortedIds = [...ids].sort((a, b) => {
			const aRunning = statusMap[a]!["state"] === "running" ? 1 : 0;
			const bRunning = statusMap[b]!["state"] === "running" ? 1 : 0;
			if (aRunning !== bRunning) return aRunning - bRunning;
			return a.localeCompare(b);
		});
		
		for (const id of sortedIds) {
			const type = agentTypes?.[id] ?? "";
			lines.push(renderAgentLine(id, type, statusMap[id]!, options.expanded));
		}
		return new Text(lines.join("\n"), 0, 0);
	}

	return new Text(JSON.stringify(data, null, 2), 0, 0);
}
