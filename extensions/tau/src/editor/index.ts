import type { ExtensionAPI, KeybindingsManager } from "@mariozechner/pi-coding-agent";
import { CustomEditor } from "@mariozechner/pi-coding-agent";
import type { AutocompleteProvider, EditorTheme, TUI } from "@mariozechner/pi-tui";

import type { TauState } from "../shared/state.js";
import { afterInput, wrapAutocompleteProvider } from "../skill-marker/index.js";
import { wrapEditorRender } from "../terminal-prompt/index.js";

export class TauEditor extends CustomEditor {
	private baseAutocompleteProvider?: AutocompleteProvider;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private state: TauState,
	) {
		super(tui, theme, keybindings);
	}

	override setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.baseAutocompleteProvider = provider;
		super.setAutocompleteProvider(wrapAutocompleteProvider(this.state, provider, this));
	}

	override handleInput(data: string): void {
		super.handleInput(data);
		afterInput(this.state, data, this);
	}

	override render(width: number): string[] {
		return wrapEditorRender(this.state, width, (w: number) => super.render(w));
	}

	rewrapAutocompleteProvider(): void {
		if (!this.baseAutocompleteProvider) return;
		this.setAutocompleteProvider(this.baseAutocompleteProvider);
	}
}

export default function initEditor(pi: ExtensionAPI, state: TauState) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		// Prefer to run after any other editor installs (legacy extensions may still be present).
		setTimeout(() => {
			ctx.ui.setEditorComponent((tui, theme, keybindings) => new TauEditor(tui, theme, keybindings, state));
		}, 1);
	});
}
