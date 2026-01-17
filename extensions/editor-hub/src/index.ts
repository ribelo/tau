import type { ExtensionAPI, KeybindingsManager } from "@mariozechner/pi-coding-agent";
import { CustomEditor } from "@mariozechner/pi-coding-agent";
import type { AutocompleteProvider, EditorTheme, TUI } from "@mariozechner/pi-tui";

import { getEditorPlugins, onEditorPluginsChanged } from "./registry.js";

class HubEditor extends CustomEditor {
	private baseAutocompleteProvider?: AutocompleteProvider;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
		super(tui, theme, keybindings);
	}

	override setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.baseAutocompleteProvider = provider;
		let current: AutocompleteProvider = provider;
		for (const plugin of getEditorPlugins()) {
			if (plugin.wrapAutocompleteProvider) {
				current = plugin.wrapAutocompleteProvider(current, this);
			}
		}
		super.setAutocompleteProvider(current);
	}

	override handleInput(data: string): void {
		super.handleInput(data);
		for (const plugin of getEditorPlugins()) {
			plugin.afterInput?.(data, this);
		}
	}

	override render(width: number): string[] {
		const baseRender = (w: number) => super.render(w);
		let render = baseRender;
		for (const plugin of getEditorPlugins()) {
			if (!plugin.render) continue;
			const prev = render;
			render = (w: number) => plugin.render!(w, prev);
		}
		return render(width);
	}

	/**
	 * Called when plugins change. We can re-wrap autocomplete provider if needed.
	 */
	reapplyPlugins(): void {
		if (this.baseAutocompleteProvider) {
			this.setAutocompleteProvider(this.baseAutocompleteProvider);
		}
	}
}

export default function editorHub(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		// Delay editor installation so other extensions can register plugins in their session_start.
		setTimeout(() => {
			ctx.ui.setEditorComponent((tui, theme, keybindings) => {
				const editor = new HubEditor(tui, theme, keybindings);
				// If plugins change later, reapply. (Usually stable after startup.)
				onEditorPluginsChanged(() => editor.reapplyPlugins());
				return editor;
			});
		}, 0);
	});
}

export * from "./registry.js";
