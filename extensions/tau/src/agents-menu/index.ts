import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import {
	Container,
	type Focusable,
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
import { AgentSelectionStore } from "./state.js";

/**
	 * Session-scoped agent enable/disable state with optional project persistence.
	 * Unsaved changes stay in memory for the current runtime. Ctrl+S saves them to project settings.
 */
const agentSelections = new AgentSelectionStore();

export function isAgentDisabledForCwd(cwd: string, name: string): boolean {
	return agentSelections.isDisabledForCwd(cwd, name);
}

export function setAgentEnabledForCwd(cwd: string, name: string, enabled: boolean): void {
	agentSelections.setEnabledForCwd(cwd, name, enabled);
}

function loadRegistry(cwd: string): Effect.Effect<AgentRegistry, never> {
	return AgentRegistry.load(cwd).pipe(
		Effect.catch(() => Effect.die("Failed to load agent registry")),
	);
}

function refreshToolDescription(agentTool: AgentToolHandle, registry: AgentRegistry, cwd: string): void {
	const description = buildToolDescription(registry, undefined, (name) => isAgentDisabledForCwd(cwd, name));
	agentTool.refresh(description);
}

interface AgentItem {
	name: string;
	description: string;
	enabled: boolean;
}

const AGENT_DESCRIPTION_MAX_CHARS = 72;

function truncateWithEllipsis(text: string, maxChars: number): string {
	const normalized = text.trim();
	if (normalized.length <= maxChars) return normalized;
	if (maxChars <= 1) return "…";
	return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

function syncAgentToolAvailability(
	pi: ExtensionAPI,
	agentTool: AgentToolHandle,
	registry: AgentRegistry,
	cwd: string,
): void {
	refreshToolDescription(agentTool, registry, cwd);

	const enabledCount = registry.names().filter((name) => !isAgentDisabledForCwd(cwd, name)).length;
	const activeTools = pi.getActiveTools();
	const hasAgentTool = activeTools.includes("agent");

	if (enabledCount === 0 && hasAgentTool) {
		pi.setActiveTools(activeTools.filter((name) => name !== "agent"));
		return;
	}

	if (enabledCount > 0 && !hasAgentTool) {
		pi.setActiveTools([...activeTools, "agent"]);
	}
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
	private onPersist: () => void;
	private onStateChange: () => void;
	private theme: Theme;
	private isDirty: boolean;

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
		cwd: string,
		theme: Theme,
		isDirty: boolean,
		done: () => void,
		onToggle: (name: string, enabled: boolean) => void,
		onPersist: () => void,
		onStateChange: () => void,
	) {
		super();
		this.theme = theme;
		this.isDirty = isDirty;
		this.doneFn = done;
		this.onToggle = onToggle;
		this.onPersist = onPersist;
		this.onStateChange = onStateChange;

		this.items = allNames.map((name) => {
			const def = registry.get(name);
			const desc = def?.description.split("\n")[0]?.trim() ?? "";
			return { name, description: desc, enabled: !agentSelections.isDisabledForCwd(cwd, name) };
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
		const base = `  Enter toggle · Ctrl+T toggle all · Ctrl+S save · Esc close · ${enabled}/${total} enabled`;
		return this.isDirty
			? this.theme.fg("dim", `${base} `) + this.theme.fg("warning", "(unsaved)")
			: this.theme.fg("dim", base);
	}

	private toggleAll(): void {
		const nextEnabled = this.items.some((item) => !item.enabled);
		for (const item of this.items) {
			if (item.enabled === nextEnabled) continue;
			item.enabled = nextEnabled;
			this.onToggle(item.name, nextEnabled);
		}
		this.isDirty = true;
		this.refresh();
		this.onStateChange();
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
			const shortDescription = truncateWithEllipsis(item.description, AGENT_DESCRIPTION_MAX_CHARS);
			const desc = shortDescription.length > 0 ? this.theme.fg("dim", ` ${shortDescription}`) : "";
			this.listContainer.addChild(new Text(`${prefix}${marker} ${nameText}${desc}`, 0, 0));
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
			this.updateList();
			return;
		}
		if (matchesKey(data, Key.down)) {
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
				this.isDirty = true;
				this.refresh();
				this.onStateChange();
			}
			return;
		}

		if (matchesKey(data, Key.ctrl("t"))) {
			this.toggleAll();
			return;
		}

		if (matchesKey(data, Key.ctrl("s"))) {
			this.onPersist();
			this.isDirty = false;
			this.footerText.setText(this.getFooterText());
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
	const syncForCwd = async (cwd: string) => {
		const registry = await Effect.runPromise(loadRegistry(cwd));
		agentSelections.activate(cwd, registry.names());
		syncAgentToolAvailability(pi, agentTool, registry, cwd);
	};

	pi.on("session_start", async (_event, ctx) => {
		const registry = await Effect.runPromise(loadRegistry(ctx.cwd));
		agentSelections.activate(ctx.cwd, registry.names());
		if (ctx.hasUI) {
			syncAgentToolAvailability(pi, agentTool, registry, ctx.cwd);
		}
	});
	pi.on("session_switch", async (_event, ctx) => {
		if (!ctx.hasUI) {
			const registry = await Effect.runPromise(loadRegistry(ctx.cwd));
			agentSelections.activate(ctx.cwd, registry.names());
			return;
		}
		await syncForCwd(ctx.cwd);
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
				agentSelections.activate(ctx.cwd, registry.names());
				const allNames = registry.names();

			const trimmed = (args || "").trim();

			if (trimmed) {
				const parts = trimmed.split(/\s+/);
				const action = parts[0]?.toLowerCase();
				const agentName = parts[1]?.toLowerCase();

				if (action === "list") {
					const lines = allNames.map((name: string) => {
						const enabled = !isAgentDisabledForCwd(ctx.cwd, name);
						const def = registry.get(name);
						const desc = truncateWithEllipsis(
							def?.description.split("\n")[0]?.trim() ?? "",
							AGENT_DESCRIPTION_MAX_CHARS,
						);
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
					setAgentEnabledForCwd(ctx.cwd, agentName, action === "enable");
					syncAgentToolAvailability(pi, agentTool, registry, ctx.cwd);
					const state = action === "enable" ? "enabled" : "disabled";
					ctx.ui.notify(`Agent "${agentName}" ${state} for this session. Open /agents and press Ctrl+S to save to project settings.`, "info");
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
						ctx.cwd,
						theme,
						agentSelections.isDirtyForCwd(ctx.cwd),
						() => done(undefined as unknown as void),
						(name, enabled) => {
							setAgentEnabledForCwd(ctx.cwd, name, enabled);
						},
						() => {
							const settingsPath = agentSelections.persistForCwd(ctx.cwd, allNames);
							ctx.ui.notify(`Saved agent selection to ${settingsPath}`, "info");
						},
						() => syncAgentToolAvailability(pi, agentTool, registry, ctx.cwd),
					);
					return selector;
				});
		},
	});
}
