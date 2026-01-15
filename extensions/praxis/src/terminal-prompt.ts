import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { CustomEditor } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";

const PRAXIS_STATE_TYPE = "praxis-state";

// Codex-style composer look:
// - bold "›" prompt
// - 1 empty row above + below (Y padding)
// - dim background for input area
const BG = "\x1b[48;5;236m";

function stripAnsi(text: string): string {
	// Good-enough ANSI SGR strip for our border detection.
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function isHorizontalBorderLine(line: string): boolean {
	const plain = stripAnsi(line);
	return plain.length > 0 && /^[─]+$/.test(plain);
}

function withBg(line: string, width: number): string {
	const padded = line + " ".repeat(Math.max(0, width - visibleWidth(line)));
	// Re-apply BG after any full reset emitted by the underlying editor (cursor uses \x1b[0m).
	const patched = padded.replaceAll("\x1b[0m", `\x1b[0m${BG}`);
	return `${BG}${patched}\x1b[0m`;
}

class TerminalPromptEditor extends CustomEditor {
	render(width: number): string[] {
		const promptPrefix = "\x1b[1m›\x1b[0m ";
		const continuationPrefix = "  ";
		const prefixWidth = 2; // visible width of "› "

		if (width <= prefixWidth) return super.render(width);
		const contentWidth = Math.max(1, width - prefixWidth);

		// Let the built-in editor do all the hard stuff (layout, cursor, autocomplete),
		// then remove its borders and add our prompt prefix.
		const base = super.render(contentWidth);
		if (base.length < 2) return base;

		// base format: [topBorder, ...contentLines, bottomBorder, ...autocomplete]
		const bottomBorderIndex = (() => {
			for (let i = base.length - 1; i >= 1; i--) {
				if (isHorizontalBorderLine(base[i]!)) return i;
			}
			return -1;
		})();

		if (bottomBorderIndex === -1) {
			// Unexpected, but don't crash; just prefix everything.
			return base.map((line, i) => withBg(`${i === 0 ? promptPrefix : continuationPrefix}${line}`, width));
		}

		const contentLines = base.slice(1, bottomBorderIndex);
		const autocompleteLines = base.slice(bottomBorderIndex + 1);

		const result: string[] = [];

		// Top Y padding
		result.push(withBg("", width));

		for (let i = 0; i < contentLines.length; i++) {
			const line = contentLines[i] ?? "";
			const prefix = i === 0 ? promptPrefix : continuationPrefix;
			// Content lines are already padded to contentWidth by Editor.render().
			result.push(withBg(prefix + line, width));
		}

		// Bottom Y padding
		result.push(withBg("", width));

		// Keep autocomplete outside of the "input area" background (more Codex-like popup).
		for (const line of autocompleteLines) {
			const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(line)));
			result.push(continuationPrefix + line + padding);
		}

		return result;
	}
}

function applyEditor(enabled: boolean, ctx: ExtensionCommandContext | any): void {
	if (!ctx.hasUI) return;
	if (enabled) {
		ctx.ui.setEditorComponent((_tui: any, theme: any, keybindings: any) => new TerminalPromptEditor(theme, keybindings));
	} else {
		ctx.ui.setEditorComponent(undefined);
	}
}

export default function praxisTerminalPrompt(pi: ExtensionAPI) {
	let enabled = true;

	pi.registerCommand("praxis", {
		description: "Praxis settings: /praxis prompt on|off|toggle",
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim();
			const parts = trimmed.split(/\s+/).filter(Boolean);

			if (parts.length === 0) {
				ctx.ui.notify(`Praxis prompt: ${enabled ? "on" : "off"}. Usage: /praxis prompt on|off|toggle`, "info");
				return;
			}

			if (parts[0] !== "prompt") {
				ctx.ui.notify("Usage: /praxis prompt on|off|toggle", "info");
				return;
			}

			const mode = parts[1] ?? "toggle";
			if (mode === "on") enabled = true;
			else if (mode === "off") enabled = false;
			else if (mode === "toggle") enabled = !enabled;
			else {
				ctx.ui.notify("Usage: /praxis prompt on|off|toggle", "info");
				return;
			}

			applyEditor(enabled, ctx);
			pi.appendEntry(PRAXIS_STATE_TYPE, { terminalPrompt: enabled });
			ctx.ui.notify(`Praxis prompt: ${enabled ? "on" : "off"}`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		// Restore last known state from session (so it survives restarts).
		const entries = ctx.sessionManager.getEntries();
		const last = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === PRAXIS_STATE_TYPE)
			.pop() as { data?: { terminalPrompt?: boolean } } | undefined;

		if (typeof last?.data?.terminalPrompt === "boolean") {
			enabled = last.data.terminalPrompt;
		}

		applyEditor(enabled, ctx);
	});
}
