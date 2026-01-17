import type { AutocompleteProvider } from "@mariozechner/pi-tui";

export type EditorRender = (width: number) => string[];

export type EditorRenderWrapper = (width: number, next: EditorRender) => string[];

export type EditorAfterInputHook = (data: string, editor: any) => void;

export type EditorAutocompleteWrapper = (provider: AutocompleteProvider, editor: any) => AutocompleteProvider;

export type EditorPlugin = {
	id: string;
	priority?: number;
	render?: EditorRenderWrapper;
	wrapAutocompleteProvider?: EditorAutocompleteWrapper;
	afterInput?: EditorAfterInputHook;
};

type RegistryState = {
	plugins: Map<string, EditorPlugin>;
	listeners: Set<() => void>;
};

const KEY = Symbol.for("tau.pi.editor_hub.registry");

function state(): RegistryState {
	const g = globalThis as any;
	if (!g[KEY]) {
		g[KEY] = { plugins: new Map(), listeners: new Set() } satisfies RegistryState;
	}
	return g[KEY] as RegistryState;
}

export function registerEditorPlugin(plugin: EditorPlugin): void {
	const s = state();
	s.plugins.set(plugin.id, plugin);
	for (const l of s.listeners) {
		try {
			l();
		} catch {
			// ignore
		}
	}
}

export function unregisterEditorPlugin(id: string): void {
	const s = state();
	if (s.plugins.delete(id)) {
		for (const l of s.listeners) {
			try {
				l();
			} catch {
				// ignore
			}
		}
	}
}

export function getEditorPlugins(): EditorPlugin[] {
	const s = state();
	return [...s.plugins.values()].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
}

export function onEditorPluginsChanged(cb: () => void): () => void {
	const s = state();
	s.listeners.add(cb);
	return () => s.listeners.delete(cb);
}
