import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { visibleWidth, type Component } from "@mariozechner/pi-tui";

const WORKED_FOR_MESSAGE_TYPE = "tau:worked-for";
const WORKED_FOR_STATE_TYPE = "tau:worked-for-state";

type WorkedForDetails = {
	elapsedMs: number;
};

type WorkedForState = {
	enabled?: boolean;
	toolsEnabled?: boolean;
};

function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

class WorkedForSeparator implements Component {
	private cachedWidth = -1;
	private cachedLines: string[] = [];

	constructor(
		private durationText: string,
		private theme: any,
	) {}

	render(width: number): string[] {
		if (width <= 0) return [""];
		if (this.cachedWidth === width && this.cachedLines.length > 0) return this.cachedLines;

		const label = ` Worked for ${this.durationText} `;
		let line = `─${label}`;

		const remaining = width - visibleWidth(line);
		if (remaining > 0) {
			line += "─".repeat(remaining);
		} else if (visibleWidth(line) > width) {
			// Safe because label uses ASCII digits/spaces.
			line = line.slice(0, width);
		}

		this.cachedWidth = width;
		this.cachedLines = [this.theme.fg("dim", line)];
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = -1;
		this.cachedLines = [];
	}
}

class WorkedForWidget implements Component {
	private separator: WorkedForSeparator;

	constructor(
		durationText: string,
		theme: any,
	) {
		this.separator = new WorkedForSeparator(durationText, theme);
	}

	render(width: number): string[] {
		// Add one empty row of padding below the separator to visually separate it from the editor.
		return [...this.separator.render(width), ""];
	}

	invalidate(): void {
		this.separator.invalidate();
	}
}

function parseToggleArg(mode: string, current: boolean): boolean | undefined {
	if (mode === "on") return true;
	if (mode === "off") return false;
	if (mode === "toggle") return !current;
	return undefined;
}

export default function tauWorkedFor(pi: ExtensionAPI) {
	let enabled = true;
	let toolsEnabled = true;

	// Start time for the current user prompt (one agent run).
	// This must NOT reset per internal turn/tool call.
	let promptStartTimestamp: number | undefined;
	let agentRunning = false;
	let lastRenderedDurationText: string | undefined;

	function persistState(): void {
		pi.appendEntry<WorkedForState>(WORKED_FOR_STATE_TYPE, { enabled, toolsEnabled });
	}

	function renderWorkedForWidget(ctx: any): void {
		if (!ctx?.hasUI) return;
		if (!enabled) return;
		if (promptStartTimestamp === undefined) return;
		const elapsedMs = Math.max(0, Date.now() - promptStartTimestamp);
		const durationText = formatDuration(elapsedMs);
		if (durationText === lastRenderedDurationText) return;
		lastRenderedDurationText = durationText;

		// Widgets do not participate in LLM context and won't enqueue follow-ups.
		ctx.ui.setWidget("worked-for-separator", (_tui: any, theme: any) => new WorkedForWidget(durationText, theme));
	}

	pi.registerMessageRenderer<WorkedForDetails>(WORKED_FOR_MESSAGE_TYPE, (message, _options, theme) => {
		const elapsedMs = typeof message.details?.elapsedMs === "number" ? message.details.elapsedMs : 0;
		return new WorkedForSeparator(formatDuration(elapsedMs), theme);
	});

	pi.on("context", async (event) => {
		// Never send UI-only worked-for separators to the model (old sessions may contain them).
		const filtered = event.messages.filter(
			(m: any) => !(m?.role === "custom" && m?.customType === WORKED_FOR_MESSAGE_TYPE),
		);
		return { messages: filtered };
	});

	pi.registerCommand("worked", {
		description: "Show elapsed work time separators: /worked on|off|toggle | /worked tools on|off|toggle",
		handler: async (args, ctx) => {
			const parts = (args || "").trim().split(/\s+/).filter(Boolean);

			if (parts.length === 0) {
				ctx.ui.notify(
					`Worked-for: ${enabled ? "on" : "off"}, tools: ${toolsEnabled ? "on" : "off"}. Usage: /worked on|off|toggle | /worked tools on|off|toggle`,
					"info",
				);
				return;
			}

			if (parts[0] === "tools") {
				const next = parseToggleArg(parts[1] ?? "toggle", toolsEnabled);
				if (typeof next !== "boolean") {
					ctx.ui.notify("Usage: /worked tools on|off|toggle", "info");
					return;
				}
				toolsEnabled = next;
				persistState();
				ctx.ui.notify(`Worked-for tools: ${toolsEnabled ? "on" : "off"}`, "info");
				return;
			}

			const next = parseToggleArg(parts[0] ?? "toggle", enabled);
			if (typeof next !== "boolean") {
				ctx.ui.notify("Usage: /worked on|off|toggle | /worked tools on|off|toggle", "info");
				return;
			}

			enabled = next;
			persistState();
			if (ctx.hasUI && !enabled) ctx.ui.setWidget("worked-for-separator", undefined);
			ctx.ui.notify(`Worked-for: ${enabled ? "on" : "off"}`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		// Restore last known state from session (so it survives restarts).
		const entries = ctx.sessionManager.getEntries();
		const last = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === WORKED_FOR_STATE_TYPE)
			.pop() as { data?: WorkedForState } | undefined;

		if (typeof last?.data?.enabled === "boolean") enabled = last.data.enabled;
		if (typeof last?.data?.toolsEnabled === "boolean") toolsEnabled = last.data.toolsEnabled;

		promptStartTimestamp = undefined;
		agentRunning = false;
		lastRenderedDurationText = undefined;

		if (ctx.hasUI) {
			ctx.ui.setWidget("worked-for-separator", undefined);
		}
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		// This is the right "start" moment: user has submitted a prompt and
		// we're about to start the agent loop. This stays stable across tool calls
		// and internal turns until agent_end.
		promptStartTimestamp = Date.now();
		agentRunning = true;
		lastRenderedDurationText = undefined;
		if (ctx.hasUI) ctx.ui.setWidget("worked-for-separator", undefined);
	});

	pi.on("agent_end", async (_event, ctx) => {
		renderWorkedForWidget(ctx);
		agentRunning = false;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!enabled || !toolsEnabled) return;
		if (!agentRunning) return;

		// Avoid spamming on frequent "read" calls.
		if (event.toolName === "read") return;

		renderWorkedForWidget(ctx);
	});

	pi.on("turn_end", async (event, ctx) => {
		persistState();
		if (!enabled) return;
		if (!agentRunning) return;

		// Only show after assistant output (Codex-like).
		const role = (event.message as any)?.role;
		if (role !== "assistant") return;

		renderWorkedForWidget(ctx);
	});
}
