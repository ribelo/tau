import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_EDITOR_KEYBINDINGS,
	EditorKeybindingsManager,
	getEditorKeybindings,
	setEditorKeybindings,
	type EditorKeybindingsConfig,
	type KeyId,
} from "@mariozechner/pi-tui";

function uniqKeys(keys: KeyId[]): KeyId[] {
	const seen = new Set<KeyId>();
	const result: KeyId[] = [];
	for (const key of keys) {
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(key);
	}
	return result;
}

function toKeyConfig(keys: KeyId[]): KeyId | KeyId[] {
	return keys.length === 1 ? keys[0]! : keys;
}

export default function praxisKeybindings(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		// Preserve existing effective keybindings (defaults + user config), then add Ctrl+J.
		const current = getEditorKeybindings();

		const config: EditorKeybindingsConfig = {};
		for (const action of Object.keys(DEFAULT_EDITOR_KEYBINDINGS) as (keyof typeof DEFAULT_EDITOR_KEYBINDINGS)[]) {
			config[action] = toKeyConfig(current.getKeys(action));
		}

		const newLineKeys = uniqKeys([...current.getKeys("newLine"), "ctrl+j"]);
		const submitKeys = current.getKeys("submit").filter((k) => k !== "ctrl+j");
		const effectiveSubmitKeys = submitKeys.length > 0 ? submitKeys : (["enter"] as KeyId[]);

		config.newLine = toKeyConfig(newLineKeys);
		config.submit = toKeyConfig(effectiveSubmitKeys);

		setEditorKeybindings(new EditorKeybindingsManager(config));

		ctx.ui.notify("Praxis: Ctrl+J inserts a newline", "info");
	});
}
