import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import {
	Container,
	type Focusable,
	getKeybindings,
	Input,
	Key,
	matchesKey,
	Spacer,
	Text,
} from "@mariozechner/pi-tui";
import { AgentRegistry } from "../agent/agent-registry.js";
import { buildToolDescription } from "../agent/tool.js";
import type { AgentToolHandle } from "../agent/index.js";
import { Effect } from "effect";

/**
 * Session-scoped agent enable/disable state.
 * All agents are enabled by default. State resets on session switch.
 */
const disabledAgents = new Set<string>();

export function isAgentDisabled(name: string): boolean {
	return disabledAgents.has(name);
}

export function setAgentEnabled(name: string, enabled: boolean): void {
	if (enabled) {
		disabledAgents.delete(name);
	} else {
		disabledAgents.add(name);
	}
}

function resetAgentStates(): void {
	disabledAgents.clear();
}

function loadRegistry(cwd: string): Effect.Effect<AgentRegistry, never> {
	return AgentRegistry.load(cwd).pipe(
		Effect.catch(() => Effect.die("Failed to load agent registry")),
	);
}

function refreshToolDescription(agentTool: AgentToolHandle, registry: AgentRegistry): void {
	const description = buildToolDescription(registry, undefined, isAgentDisabled);
	agentTool.refresh(description);
}

interface AgentItem {
	name: string;
	description: string;
	enabled: boolean;
}

/**
 * TUI component for toggling agents on/off. Stays open until Escape.
 */
class AgentsSelectorComponent extends Container implements Focusable {
	private items: AgentItem[] = [];
	private selectedIndex = 0;
	private searchInput: Input;
	private filteredItems: AgentItem[] = [];
	private listContainer: Container;
	private footerText: Text;
	private doneFn: () => void;
	private onToggle: (name: string, enabled: boolean) => void;
	private theme: Theme;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		allNames: string[],
		registry: AgentRegistry,
		theme: Theme,
		done: () => void,
		onToggle: (name: string, enabled: boolean) => void,
	) {
		super();
		this.theme = theme;
		this.doneFn = done;
		this.onToggle = onToggle;

		this.items = allNames.map((name) => {
			const def = registry.get(name);
			const desc = def?.description.split("\n")[0]?.trim() ?? "";
			return { name, description: desc, enabled: !isAgentDisabled(name) };
		});
		this.filteredItems = [...this.items];

		// Search input
		this.searchInput = new Input();
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		// List
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		// Footer
		this.addChild(new Spacer(1));
		this.footerText = new Text(this.getFooterText(), 0, 0);
		this.addChild(this.footerText);

		this.updateList();
	}

	private getFooterText(): string {
		const enabled = this.items.filter((i) => i.enabled).length;
		const total = this.items.length;
		return this.theme.fg("dim", `  Enter toggle · Esc close · ${enabled}/${total} enabled`);
	}

	private refresh(): void {
		const query = this.searchInput.getValue().toLowerCase();
		this.filteredItems = query
			? this.items.filter((i) => i.name.toLowerCase().includes(query) || i.description.toLowerCase().includes(query))
			: [...this.items];
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
		this.updateList();
		this.footerText.setText(this.getFooterText());
	}

	private updateList(): void {
		this.listContainer.clear();

		if (this.filteredItems.length === 0) {
			this.listContainer.addChild(new Text(this.theme.fg("muted", "  No matching agents"), 0, 0));
			return;
		}

		for (let i = 0; i < this.filteredItems.length; i++) {
			const item = this.filteredItems[i]!;
			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? this.theme.fg("accent", "> ") : "  ";
			const marker = item.enabled ? this.theme.fg("success", "✔") : this.theme.fg("dim", "✗");
			const nameText = isSelected ? this.theme.fg("accent", item.name) : item.name;
			const desc = this.theme.fg("dim", ` ${item.description}`);
			this.listContainer.addChild(new Text(`${prefix}${marker} ${nameText}${desc}`, 0, 0));
		}
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		if (kb.matches(data, "tui.select.up")) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
			this.updateList();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
			return;
		}

		// Toggle on Enter
		if (matchesKey(data, Key.enter)) {
			const item = this.filteredItems[this.selectedIndex];
			if (item) {
				item.enabled = !item.enabled;
				this.onToggle(item.name, item.enabled);
				this.refresh();
			}
			return;
		}

		// Close on Escape
		if (matchesKey(data, Key.escape)) {
			this.doneFn();
			return;
		}

		// Ctrl+C: clear search or close
		if (matchesKey(data, Key.ctrl("c"))) {
			if (this.searchInput.getValue()) {
				this.searchInput.setValue("");
				this.refresh();
			} else {
				this.doneFn();
			}
			return;
		}

		// Pass to search input
		this.searchInput.handleInput(data);
		this.refresh();
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}

export default function initAgentsMenu(pi: ExtensionAPI, agentTool: AgentToolHandle): void {
	// Reset on session boundaries
	pi.on("session_start", async () => {
		resetAgentStates();
		const registry = await Effect.runPromise(loadRegistry(process.cwd()));
		refreshToolDescription(agentTool, registry);
	});
	pi.on("session_switch", async () => {
		resetAgentStates();
		const registry = await Effect.runPromise(loadRegistry(process.cwd()));
		refreshToolDescription(agentTool, registry);
	});

	pi.registerCommand("agents", {
		description: "Enable/disable agents for this session",
		getArgumentCompletions(prefix: string) {
			const words = prefix.trimStart().split(/\s+/);
			if (words.length <= 1) {
				const sub = words[0] ?? "";
				return ["list", "enable", "disable"]
					.filter((s) => s.startsWith(sub))
					.map((s) => ({ value: s, label: s }));
			}
			return null;
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;

			const registry = await Effect.runPromise(loadRegistry(ctx.cwd));
			const allNames = registry.names();

			const trimmed = (args || "").trim();

			if (trimmed) {
				const parts = trimmed.split(/\s+/);
				const action = parts[0]?.toLowerCase();
				const agentName = parts[1]?.toLowerCase();

				if (action === "list") {
					const lines = allNames.map((name: string) => {
						const enabled = !isAgentDisabled(name);
						const def = registry.get(name);
						const desc = def?.description.split("\n")[0]?.trim() ?? "";
						const marker = enabled ? "✔" : "✗";
						return `${marker} ${name}: ${desc}`;
					});
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}

				if ((action === "enable" || action === "disable") && agentName) {
					if (!registry.has(agentName)) {
						ctx.ui.notify(
							`Unknown agent: "${agentName}". Available: ${allNames.join(", ")}`,
							"error",
						);
						return;
					}
					setAgentEnabled(agentName, action === "enable");
					refreshToolDescription(agentTool, registry);
					const state = action === "enable" ? "enabled" : "disabled";
					ctx.ui.notify(`Agent "${agentName}" ${state}`, "info");
					return;
				}

				ctx.ui.notify(
					"Usage: /agents [list | enable <name> | disable <name>]",
					"info",
				);
				return;
			}

			// Interactive toggle selector using ctx.ui.custom
			await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
				const selector = new AgentsSelectorComponent(
					allNames,
					registry,
					theme,
					() => done(undefined as unknown as void),
					(name, enabled) => {
						setAgentEnabled(name, enabled);
						refreshToolDescription(agentTool, registry);
					},
				);
				return selector;
			});
		},
	});
}
