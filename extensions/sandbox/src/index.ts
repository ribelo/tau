import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createBashTool, createEditTool, createWriteTool, getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import { Container, Input, SettingsList, Text, type SettingItem } from "@mariozechner/pi-tui";

import type { SandboxConfig } from "./config.js";
import { computeEffectiveConfig, ensureUserDefaults } from "./config.js";
import { discoverWorkspaceRoot } from "./workspace-root.js";

const STATE_TYPE = "sandbox_state";
const INHERIT = "inherit";

const FILESYSTEM_VALUES = [INHERIT, "read-only", "workspace-write", "danger-full-access"] as const;
const NETWORK_VALUES = [INHERIT, "deny", "allowlist", "allow-all"] as const;
const APPROVAL_VALUES = [INHERIT, "never", "ask", "on-failure"] as const;
const TIMEOUT_VALUES = [INHERIT, "15", "30", "60", "120", "300"] as const;

type SessionState = {
	override?: SandboxConfig;
};

function loadSessionOverride(ctx: ExtensionContext): SandboxConfig | undefined {
	const entries = ctx.sessionManager.getBranch();
	let last: SessionState | undefined;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === STATE_TYPE) {
			last = entry.data as SessionState | undefined;
		}
	}
	return last?.override ? { ...last.override } : undefined;
}

function parseAllowlist(input: string): string[] {
	return Array.from(
		new Set(
			input
				.split(/[,\s]+/)
				.map((value) => value.trim())
				.filter(Boolean),
		),
	).sort();
}

function formatAllowlist(list: string[]): string {
	if (list.length === 0) return "(none)";
	if (list.length <= 3) return list.join(", ");
	return `${list.length} domains`;
}

function buildSourceHint(sessionOverride: SandboxConfig | undefined, key: keyof SandboxConfig): string {
	return sessionOverride?.[key] !== undefined ? "session override" : "inherited";
}

export default function sandbox(pi: ExtensionAPI) {
	// First-run: ensure sandbox defaults are written into ~/.pi/agent/settings.json (only fills missing keys).
	ensureUserDefaults();

	let workspaceRoot = process.cwd();
	let sessionOverride: SandboxConfig | undefined;
	let effectiveConfig = computeEffectiveConfig({ workspaceRoot, sessionOverride });

	function refreshConfig(ctx: ExtensionContext) {
		workspaceRoot = discoverWorkspaceRoot(ctx.cwd);
		sessionOverride = loadSessionOverride(ctx);
		effectiveConfig = computeEffectiveConfig({ workspaceRoot, sessionOverride });
	}

	function persistState() {
		pi.appendEntry<SessionState>(STATE_TYPE, { override: sessionOverride });
	}

	function setOverrideValue<K extends keyof SandboxConfig>(key: K, value: SandboxConfig[K] | undefined) {
		const next: SandboxConfig = { ...(sessionOverride ?? {}) };
		if (value === undefined) {
			delete next[key];
		} else {
			next[key] = value;
		}

		sessionOverride = Object.keys(next).length > 0 ? next : undefined;
		effectiveConfig = computeEffectiveConfig({ workspaceRoot, sessionOverride });
		persistState();
	}

	function updateSettingFromSelect<K extends keyof SandboxConfig>(key: K, value: string) {
		if (value === INHERIT) {
			setOverrideValue(key, undefined);
			return;
		}
		setOverrideValue(key, value as SandboxConfig[K]);
	}

	function updateAllowlistFromInput(rawValue: string) {
		const trimmed = rawValue.trim();
		if (!trimmed) {
			setOverrideValue("networkAllowlist", []);
			return;
		}
		if (trimmed.toLowerCase() === INHERIT) {
			setOverrideValue("networkAllowlist", undefined);
			return;
		}
		setOverrideValue("networkAllowlist", parseAllowlist(trimmed));
	}

	function updateTimeoutFromSelect(rawValue: string, ctx: ExtensionContext) {
		if (rawValue === INHERIT) {
			setOverrideValue("approvalTimeoutSeconds", undefined);
			return;
		}
		const parsed = Number.parseInt(rawValue, 10);
		if (!Number.isFinite(parsed) || parsed <= 0) {
			ctx.ui.notify(`Invalid timeout: ${rawValue}`, "warning");
			return;
		}
		setOverrideValue("approvalTimeoutSeconds", parsed);
	}

	function buildSandboxSummary(): string {
		const lines = [
			"Sandbox configuration:",
			`Filesystem: ${effectiveConfig.filesystemMode}`,
			`Network: ${effectiveConfig.networkMode}`,
			`Allowlist: ${formatAllowlist(effectiveConfig.networkAllowlist)}`,
			`Approval: ${effectiveConfig.approvalPolicy}`,
			`Timeout: ${effectiveConfig.approvalTimeoutSeconds}s`,
		];
		return lines.join("\n");
	}

	async function showSandboxSettings(ctx: ExtensionContext) {
		if (!ctx.hasUI) {
			console.log(buildSandboxSummary());
			return;
		}

		await ctx.ui.custom((tui, theme, _kb, done) => {
			const items: SettingItem[] = [
				{
					id: "filesystemMode",
					label: "Filesystem mode",
					currentValue: effectiveConfig.filesystemMode,
					values: [...FILESYSTEM_VALUES],
					description: buildSourceHint(sessionOverride, "filesystemMode"),
				},
				{
					id: "networkMode",
					label: "Network mode",
					currentValue: effectiveConfig.networkMode,
					values: [...NETWORK_VALUES],
					description: buildSourceHint(sessionOverride, "networkMode"),
				},
				{
					id: "networkAllowlist",
					label: "Network allowlist",
					currentValue: formatAllowlist(effectiveConfig.networkAllowlist),
					description: `Used when network mode is allowlist (${buildSourceHint(
						sessionOverride,
						"networkAllowlist",
					)})`,
					submenu: (_currentValue, doneSubmenu) => {
						const input = new Input();
						input.setValue(effectiveConfig.networkAllowlist.join(", "));
						input.onSubmit = (value) => doneSubmenu(value);
						input.onEscape = () => doneSubmenu(undefined);

						return {
							render(width: number) {
								const lines: string[] = [];
								lines.push(theme.fg("accent", theme.bold("Edit network allowlist")));
								lines.push(theme.fg("muted", "Comma-separated domains. Type 'inherit' to reset."));
								lines.push("");
								lines.push(...input.render(width));
								lines.push("");
								lines.push(theme.fg("dim", "Enter to save · Esc to cancel"));
								return lines;
							},
							handleInput(data: string) {
								input.handleInput(data);
								tui.requestRender();
							},
							invalidate() {
								input.invalidate?.();
							},
						};
					},
				},
			];

			const container = new Container();
			container.addChild(new Text(theme.fg("accent", theme.bold("Sandbox settings")), 1, 1));

			const settingsList = new SettingsList(
				items,
				Math.min(items.length + 2, 15),
				getSettingsListTheme(),
				(id, newValue) => {
					if (id === "filesystemMode") {
						updateSettingFromSelect("filesystemMode", newValue);
					}
					if (id === "networkMode") {
						updateSettingFromSelect("networkMode", newValue);
					}
					if (id === "networkAllowlist") {
						updateAllowlistFromInput(newValue);
					}

					items.find((item) => item.id === "filesystemMode")!.description = buildSourceHint(
						sessionOverride,
						"filesystemMode",
					);
					items.find((item) => item.id === "networkMode")!.description = buildSourceHint(
						sessionOverride,
						"networkMode",
					);
					items.find((item) => item.id === "networkAllowlist")!.description = `Used when network mode is allowlist (${buildSourceHint(
						sessionOverride,
						"networkAllowlist",
					)})`;

					settingsList.updateValue("filesystemMode", effectiveConfig.filesystemMode);
					settingsList.updateValue("networkMode", effectiveConfig.networkMode);
					settingsList.updateValue("networkAllowlist", formatAllowlist(effectiveConfig.networkAllowlist));
				},
				() => done(undefined),
			);
			container.addChild(settingsList);

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					settingsList.handleInput?.(data);
					tui.requestRender();
				},
			};
		});
	}

	async function showApprovalSettings(ctx: ExtensionContext) {
		if (!ctx.hasUI) {
			console.log(buildSandboxSummary());
			return;
		}

		await ctx.ui.custom((tui, theme, _kb, done) => {
			const items: SettingItem[] = [
				{
					id: "approvalPolicy",
					label: "Approval policy",
					currentValue: effectiveConfig.approvalPolicy,
					values: [...APPROVAL_VALUES],
					description: buildSourceHint(sessionOverride, "approvalPolicy"),
				},
				{
					id: "approvalTimeoutSeconds",
					label: "Approval timeout (s)",
					currentValue: String(effectiveConfig.approvalTimeoutSeconds),
					values: [...TIMEOUT_VALUES],
					description: buildSourceHint(sessionOverride, "approvalTimeoutSeconds"),
				},
			];

			const container = new Container();
			container.addChild(new Text(theme.fg("accent", theme.bold("Approval settings")), 1, 1));

			const settingsList = new SettingsList(
				items,
				Math.min(items.length + 2, 12),
				getSettingsListTheme(),
				(id, newValue) => {
					if (id === "approvalPolicy") {
						updateSettingFromSelect("approvalPolicy", newValue);
					}
					if (id === "approvalTimeoutSeconds") {
						updateTimeoutFromSelect(newValue, ctx);
					}

					items.find((item) => item.id === "approvalPolicy")!.description = buildSourceHint(
						sessionOverride,
						"approvalPolicy",
					);
					items.find((item) => item.id === "approvalTimeoutSeconds")!.description = buildSourceHint(
						sessionOverride,
						"approvalTimeoutSeconds",
					);

					settingsList.updateValue("approvalPolicy", effectiveConfig.approvalPolicy);
					settingsList.updateValue("approvalTimeoutSeconds", String(effectiveConfig.approvalTimeoutSeconds));
				},
				() => done(undefined),
			);
			container.addChild(settingsList);

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					settingsList.handleInput?.(data);
					tui.requestRender();
				},
			};
		});
	}

	const baseBashTool = createBashTool(process.cwd());
	const baseEditTool = createEditTool(process.cwd());
	const baseWriteTool = createWriteTool(process.cwd());

	pi.registerTool({
		...baseBashTool,
		label: "bash",
		async execute(toolCallId, params, onUpdate, ctx, signal) {
			const tool = createBashTool(ctx.cwd);
			return tool.execute(toolCallId, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...baseEditTool,
		label: "edit",
		async execute(toolCallId, params, _onUpdate, ctx, signal) {
			const tool = createEditTool(ctx.cwd);
			return tool.execute(toolCallId, params, signal);
		},
	});

	pi.registerTool({
		...baseWriteTool,
		label: "write",
		async execute(toolCallId, params, _onUpdate, ctx, signal) {
			const tool = createWriteTool(ctx.cwd);
			return tool.execute(toolCallId, params, signal);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		refreshConfig(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		refreshConfig(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		refreshConfig(ctx);
	});

	pi.registerCommand("sandbox", {
		description: "Configure sandbox filesystem and network modes",
		handler: async (_args, ctx) => {
			refreshConfig(ctx);
			await showSandboxSettings(ctx);
		},
	});

	pi.registerCommand("approval", {
		description: "Configure sandbox approval policy",
		handler: async (_args, ctx) => {
			refreshConfig(ctx);
			await showApprovalSettings(ctx);
		},
	});
}

export * from "./config.js";
export * from "./workspace-root.js";
