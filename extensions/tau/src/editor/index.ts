import type { ExtensionAPI, KeybindingsManager } from "@mariozechner/pi-coding-agent";
import { CustomEditor } from "@mariozechner/pi-coding-agent";
import type { AutocompleteProvider, EditorTheme, TUI } from "@mariozechner/pi-tui";

import type { TauPersistedState } from "../shared/state.js";
import {
	shouldAutoTriggerSkillAutocomplete,
	wrapAutocompleteProvider,
	type SkillMarkerRuntime,
} from "../skill-marker/index.js";
import { wrapEditorRender } from "../terminal-prompt/index.js";

type EditorWithPrivates = {
	tryTriggerAutocomplete: (explicitTab?: boolean) => void;
};

interface EditorDeps {
	readonly getSnapshot: () => TauPersistedState;
	readonly skillMarker: SkillMarkerRuntime;
}

class TauEditor extends CustomEditor {
	private baseAutocompleteProvider?: AutocompleteProvider;
	private readonly deps: EditorDeps;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, deps: EditorDeps) {
		super(tui, theme, keybindings);
		this.deps = deps;
	}

	override setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.baseAutocompleteProvider = provider;
		super.setAutocompleteProvider(wrapAutocompleteProvider(this.deps.skillMarker, provider));
	}

	override handleInput(data: string): void {
		super.handleInput(data);

		if (shouldAutoTriggerSkillAutocomplete(this, data)) {
			(this as unknown as EditorWithPrivates).tryTriggerAutocomplete();
		}
	}

	override render(width: number): string[] {
		return wrapEditorRender(this.deps.getSnapshot, width, (w: number) => super.render(w));
	}

	rewrapAutocompleteProvider(): void {
		if (!this.baseAutocompleteProvider) return;
		this.setAutocompleteProvider(this.baseAutocompleteProvider);
	}
}

export default function initEditor(pi: ExtensionAPI, deps: EditorDeps) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		setTimeout(() => {
			ctx.ui.setEditorComponent(
				(tui, theme, keybindings) => new TauEditor(tui, theme, keybindings, deps),
			);
		}, 1);
	});
}
