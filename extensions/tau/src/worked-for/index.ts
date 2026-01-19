import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { visibleWidth, type Component } from "@mariozechner/pi-tui";
import type { Message } from "@mariozechner/pi-ai";

import type { TauState } from "../shared/state.js";
import { updatePersistedState } from "../shared/state.js";

const WORKED_FOR_MESSAGE_TYPE = "tau:worked-for";

type WorkedForDetails = {
	elapsedMs: number;
};

type WorkedForState = {
	enabled?: boolean;
	toolsEnabled?: boolean;
};

type Theme = {
	fg: (key: string, s: string) => string;
	bold: (s: string) => string;
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
		private theme: Theme,
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
		theme: Theme,
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

export default function initWorkedFor(pi: ExtensionAPI, state: TauState) {
	function isEnabled(): boolean {
		return state.persisted?.workedFor?.enabled ?? true;
	}

	function areToolsEnabled(): boolean {
		return state.persisted?.workedFor?.toolsEnabled ?? true;
	}

	// Start time for the current user prompt (one agent run).
	// This must NOT reset per internal turn/tool call.
	let promptStartTimestamp: number | undefined;
	let agentRunning = false;
	let lastRenderedDurationText: string | undefined;

	let tickInterval: ReturnType<typeof setInterval> | undefined;
	let tickCtx: ExtensionContext | undefined;

	function stopTick(): void {
		if (tickInterval) clearInterval(tickInterval);
		tickInterval = undefined;
		tickCtx = undefined;
	}

	function renderWorkedForWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!isEnabled()) return;
		if (promptStartTimestamp === undefined) return;
		const elapsedMs = Math.max(0, Date.now() - promptStartTimestamp);
		const durationText = formatDuration(elapsedMs);
		if (durationText === lastRenderedDurationText) return;
		lastRenderedDurationText = durationText;

		// Widgets do not participate in LLM context and won't enqueue follow-ups.
		ctx.ui.setWidget("worked-for-separator", (_tui: unknown, theme: Theme) => new WorkedForWidget(durationText, theme));
	}

	function startTick(ctx: ExtensionContext): void {
		stopTick();
		tickCtx = ctx;
		// Update like the "Working..." indicator: periodically re-render while the agent is running.
		// formatDuration() only changes once per second, so this is cheap.
		tickInterval = setInterval(() => {
			if (!agentRunning || !tickCtx) return;
			renderWorkedForWidget(tickCtx);
		}, 250);
	}

	function sendWorkedForSeparator(ctx: ExtensionContext): void {
		if (!isEnabled()) return;
		if (promptStartTimestamp === undefined) return;
		const elapsedMs = Math.max(0, Date.now() - promptStartTimestamp);

		// UI-only history entry (Codex-like). Must not trigger a new turn.
		pi.sendMessage(
			{
				customType: WORKED_FOR_MESSAGE_TYPE,
				content: "",
				display: true,
				details: { elapsedMs } satisfies WorkedForDetails,
			},
			{ triggerTurn: false },
		);

		if (ctx.hasUI) ctx.ui.setWidget("worked-for-separator", undefined);
	}

	pi.registerMessageRenderer<WorkedForDetails>(WORKED_FOR_MESSAGE_TYPE, (message, _options, theme) => {
		const elapsedMs = typeof message.details?.elapsedMs === "number" ? message.details.elapsedMs : 0;
		return new WorkedForSeparator(formatDuration(elapsedMs), theme as Theme);
	});

	pi.on("context", async (event) => {
		// Never send UI-only worked-for separators to the model (old sessions may contain them).
		const filtered = event.messages.filter((m) => m?.customType !== WORKED_FOR_MESSAGE_TYPE);
		return { messages: filtered };
	});

	pi.registerCommand("worked", {
		description: "Show elapsed work time separators: /worked on|off|toggle | /worked tools on|off|toggle",
		handler: async (args, ctx) => {
			const parts = (args || "").trim().split(/\s+/).filter(Boolean);

			if (parts.length === 0) {
				ctx.ui.notify(
					`Worked-for: ${isEnabled() ? "on" : "off"}, tools: ${areToolsEnabled() ? "on" : "off"}. Usage: /worked on|off|toggle | /worked tools on|off|toggle`,
					"info",
				);
				return;
			}

			if (parts[0] === "tools") {
				const next = parseToggleArg(parts[1] ?? "toggle", areToolsEnabled());
				if (typeof next !== "boolean") {
					ctx.ui.notify("Usage: /worked tools on|off|toggle", "info");
					return;
				}
				updatePersistedState(pi, state, { workedFor: { enabled: isEnabled(), toolsEnabled: next } satisfies WorkedForState });

				if (agentRunning && isEnabled()) {
					renderWorkedForWidget(ctx);
				}

				ctx.ui.notify(`Worked-for tools: ${next ? "on" : "off"}`, "info");
				return;
			}

			const next = parseToggleArg(parts[0] ?? "toggle", isEnabled());
			if (typeof next !== "boolean") {
				ctx.ui.notify("Usage: /worked on|off|toggle | /worked tools on|off|toggle", "info");
				return;
			}

			updatePersistedState(pi, state, { workedFor: { enabled: next, toolsEnabled: areToolsEnabled() } });

			if (!next) {
				stopTick();
				if (ctx.hasUI) ctx.ui.setWidget("worked-for-separator", undefined);
			} else {
				renderWorkedForWidget(ctx);
				if (agentRunning && ctx.hasUI) startTick(ctx);
			}

			ctx.ui.notify(`Worked-for: ${next ? "on" : "off"}`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		promptStartTimestamp = undefined;
		agentRunning = false;
		lastRenderedDurationText = undefined;
		stopTick();

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
		renderWorkedForWidget(ctx);
		if (isEnabled() && ctx.hasUI) startTick(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		agentRunning = false;
		stopTick();
		sendWorkedForSeparator(ctx);
		promptStartTimestamp = undefined;
		lastRenderedDurationText = undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!isEnabled() || !areToolsEnabled()) return;
		if (!agentRunning) return;

		// Avoid spamming on frequent "read" calls.
		if (event.toolName === "read") return;

		renderWorkedForWidget(ctx);
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!isEnabled()) return;
		if (!agentRunning) return;

		// Only update the widget after assistant output.
		const role = (event.message as Message)?.role;
		if (role !== "assistant") return;

		renderWorkedForWidget(ctx);
	});
}
