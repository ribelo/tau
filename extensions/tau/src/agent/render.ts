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
	if (state === "failed") return theme.fg("error", "✗");
	if (state === "running") {
		const blinkOn = Math.floor(Date.now() / 600) % 2 === 0;
		return blinkOn ? theme.fg("muted", "•") : theme.fg("dim", "◦");
	}
	return theme.fg("dim", "◦");
}

export function renderAgentCall(_args: unknown, _theme: Theme) {
	return new Text("", 0, 0);
}

export function renderAgentResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
) {
	if (typeof result === "object" && result !== null && "isError" in result && result.isError) {
		const first = result.content?.[0];
		const text = first && first.type === "text" ? first.text : "(error)";
		return new Text(theme.fg("error", `✗ agent error: ${text}`), 0, 0);
	}

	const data = (result.details || result) as Record<string, unknown>;

	// Helper to render a single agent status line
	const renderAgentLine = (id: string, type: string, status: Record<string, unknown>) => {
		const state = (status["state"] as string) || "unknown";
		let line = `  ${statusMark(state, theme)} ${theme.fg("accent", id)} ${theme.fg("dim", type)} ${theme.fg("dim", state)}`;
		if (status["message"]) {
			line += `\n    ${theme.fg("dim", "↩ ")}${theme.fg("toolOutput", truncate(oneLine(status["message"] as string), 140))}`;
		}
		if (status["reason"]) {
			line += `\n    ${theme.fg("error", `✗ ${status["reason"]}`)}`;
		}
		return line;
	};

	// spawn
	if (data["agent_id"] && !data["agents"] && !data["status"]) {
		return new Text(
			`${theme.fg("success", "✔")} agent spawn → ${theme.fg("accent", data["agent_id"] as string)}`,
			0,
			0,
		);
	}

	// send
	if (data["submission_id"]) {
		return new Text(
			`${theme.fg("success", "✔")} agent send (submission: ${theme.fg("dim", data["submission_id"] as string)})`,
			0,
			0,
		);
	}

	// close
	if (data["status"] === "closed") {
		return new Text(`${theme.fg("success", "✔")} agent close → shutdown`, 0, 0);
	}

	// list
	if (Array.isArray(data["agents"])) {
		const agents = data["agents"] as Array<{ id: string; type: string; status: Record<string, unknown> }>;
		const lines = [`${theme.fg("success", "✔")} agent list (${agents.length})`];
		for (const a of agents) {
			lines.push(renderAgentLine(a.id, a.type, a.status));
		}
		return new Text(lines.join("\n"), 0, 0);
	}

	// wait
	if (data["status"] && typeof data["status"] === "object") {
		const statusMap = data["status"] as Record<string, Record<string, unknown>>;
		const ids = Object.keys(statusMap);
		const lines = [
			`${data["timedOut"] ? theme.fg("warning", "!") : theme.fg("success", "✔")} agent wait (${ids.length} agents)${data["timedOut"] ? " (timed out)" : ""}`,
		];
		for (const id of ids) {
			lines.push(renderAgentLine(id, "", statusMap[id]!));
		}
		return new Text(lines.join("\n"), 0, 0);
	}

	return new Text(JSON.stringify(data, null, 2), 0, 0);
}
