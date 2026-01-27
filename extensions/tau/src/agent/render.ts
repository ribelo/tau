import { Text } from "@mariozechner/pi-tui";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ToolRenderResultOptions, Theme } from "@mariozechner/pi-coding-agent";

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
			const idList = ids.length <= 3
				? ids.map(id => id.slice(0, 8)).join(", ")
				: `${ids.slice(0, 2).map(id => id.slice(0, 8)).join(", ")} +${ids.length - 2} more`;
			return new Text(
				`${theme.fg("dim", "◷")} ${theme.fg("accent", `wait:[${idList}]`)}`,
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

	// Helper to render a single agent status line
	const renderAgentLine = (id: string, type: string, status: Record<string, unknown>) => {
		const state = (status["state"] as string) || "unknown";
		const idStr = id.slice(0, 8);
		const typeStr = type ? ` (${type})` : "";
		let line = `  ${statusMark(state, theme)} ${theme.fg("accent", idStr)}${theme.fg("dim", typeStr)} ${theme.fg("dim", state)}`;
		if (status["message"]) {
			line += `\n    ${theme.fg("dim", "↩ ")}${theme.fg("toolOutput", truncate(oneLine(status["message"] as string), 140))}`;
		}
		if (status["reason"]) {
			line += `\n    ${theme.fg("error", `✘ ${status["reason"]}`)}`;
		}
		return line;
	};

	// spawn
	if (data["agent_id"] && data["status"] === "running") {
		return new Text(
			`${theme.fg("success", "✔")} ${theme.fg("accent", (data["agent_id"] as string).slice(0, 8))} ${theme.fg("dim", "(running)")}`,
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
		const lines = [];
		for (const a of agents) {
			lines.push(renderAgentLine(a.id, a.type, a.status));
		}
		return new Text(lines.join("\n"), 0, 0);
	}

	// wait
	if (data["status"] && typeof data["status"] === "object") {
		const statusMap = data["status"] as Record<string, Record<string, unknown>>;
		const ids = Object.keys(statusMap);
		const lines = [];
		for (const id of ids) {
			lines.push(renderAgentLine(id, "", statusMap[id]!));
		}
		return new Text(lines.join("\n"), 0, 0);
	}

	return new Text(JSON.stringify(data, null, 2), 0, 0);
}

