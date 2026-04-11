import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as os from "node:os";

import type { BashOperations, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createWriteTool,
	getSettingsListTheme,
} from "@mariozechner/pi-coding-agent";
import { Container, SettingsList, Text, type SettingItem } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import {
	checkBashApproval,
	checkFilesystemApproval,
	looksLikePolicyViolation,
	requestApprovalAfterFailure,
} from "./approval.js";
import { classifySandboxFailure } from "./sandbox-diagnostics.js";
import {
	buildSandboxChangeNoticeText,
	buildSandboxStateNoticeText,
	computeSandboxConfigHash,
	injectSandboxNoticeIntoMessages,
} from "./sandbox-change.js";
import type { ResolvedSandboxConfig, SandboxConfig, SandboxPreset } from "./config.js";
import { computeEffectiveConfig, ensureUserDefaults } from "./config.js";
import { checkWriteAllowed } from "./fs-policy.js";
import { wrapCommandWithSandbox, isAsrtAvailable, getAsrtLoadError } from "./bash.js";
import { detectMissingSandboxDeps, formatMissingDepsMessage } from "./sandbox-prereqs.js";
import { discoverWorkspaceRoot } from "./workspace-root.js";
import { createApplyPatchToolDefinition } from "./apply-patch.js";
import {
	getLegacyMutationToolSelection,
	rewriteMutationToolNames,
	shouldUseApplyPatchForProvider,
	type LegacyMutationToolName,
} from "./mutation-tools.js";

import { isRecord } from "../shared/json.js";
import type { TauPersistedState } from "../shared/state.js";
import { loadPersistedState } from "../shared/state.js";
import { type ApprovalBroker, getWorkerApprovalBroker } from "../agent/approval-broker.js";
import { SANDBOX_PRESET_NAMES } from "../shared/policy.js";

type SandboxStateInternal = {
	createSandboxedBashOperations?:
		| ((ctx: ExtensionContext, escalate: boolean) => BashOperations)
		| undefined;
	workspaceRoot?: string | undefined;
	effectiveConfig?: ResolvedSandboxConfig | undefined;
	approvalBroker?: ApprovalBroker | undefined;
};

let runtimeState: SandboxStateInternal = {};

function getSandboxRuntimeState(): SandboxStateInternal {
	return runtimeState;
}

function updateSandboxRuntimeState(patch: Partial<SandboxStateInternal>): void {
	runtimeState = { ...runtimeState, ...patch };
}

/**
 * Kill a process and all its children.
 */
function killProcessTree(pid: number): void {
	try {
		// On Unix, kill the process group
		process.kill(-pid, "SIGTERM");
	} catch {
		try {
			// Fallback: kill just the process
			process.kill(pid, "SIGTERM");
		} catch {
			// Already dead
		}
	}
}

const SANDBOX_CHANGE_MESSAGE_TYPE = "sandbox:change";

const PRESET_VALUES: readonly SandboxPreset[] = SANDBOX_PRESET_NAMES;

const PRESET_LABELS: Record<SandboxPreset, string> = {
	"read-only": "Read Only",
	"workspace-write": "Workspace Write",
	"full-access": "Full Access",
};

type SessionState = {
	/**
	 * When ASRT is unavailable due to missing deps, we prompt once per session.
	 * This caches the user's choice.
	 */
	sandboxUnavailableDecision?: "allow" | "deny" | undefined;

	/**
	 * Session-local sandbox overrides set via the sandbox settings UI.
	 * These are stored in the session history (tau:state) and do not touch project files.
	 */
	sessionOverride?: SandboxConfig | undefined;

	/**
	 * True once we have injected sandbox *semantics* into the system prompt
	 * on the first model turn.
	 */
	systemPromptInjected?: boolean | undefined;

	/** Hash of the sandbox config last communicated to the model. */
	lastCommunicatedHash?: string | undefined;

	/** Pending SANDBOX_CHANGE notice to inject into the next user message as content[0]. */
	pendingSandboxNotice?: { hash: string; text: string } | undefined;

	/** Remember the non-apply_patch mutation tool selection for provider switching. */
	legacyMutationTools?: LegacyMutationToolName[] | undefined;
};

function readSessionOverride(value: unknown): SandboxConfig | undefined {
	if (!isRecord(value)) return undefined;
	const next: SandboxConfig = {};

	const preset = value["preset"];
	if (preset === "read-only" || preset === "workspace-write" || preset === "full-access") {
		next.preset = preset;
	}

	const subagent = value["subagent"];
	if (typeof subagent === "boolean") {
		next.subagent = subagent;
	}

	return next;
}

function sessionStateToPersisted(state: SessionState): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (state.sandboxUnavailableDecision)
		out["sandboxUnavailableDecision"] = state.sandboxUnavailableDecision;
	if (state.sessionOverride) out["sessionOverride"] = { ...state.sessionOverride };
	if (typeof state.systemPromptInjected === "boolean")
		out["systemPromptInjected"] = state.systemPromptInjected;
	if (typeof state.lastCommunicatedHash === "string")
		out["lastCommunicatedHash"] = state.lastCommunicatedHash;
	if (state.pendingSandboxNotice) {
		out["pendingSandboxNotice"] = {
			hash: state.pendingSandboxNotice.hash,
			text: state.pendingSandboxNotice.text,
		};
	}
	if (state.legacyMutationTools && state.legacyMutationTools.length > 0) {
		out["legacyMutationTools"] = [...state.legacyMutationTools];
	}
	return out;
}

function loadSessionState(persisted: TauPersistedState | undefined): SessionState | undefined {
	const raw = persisted?.sandbox;
	if (!isRecord(raw)) return undefined;

	const result: SessionState = {};

	const sandboxUnavailableDecision = raw["sandboxUnavailableDecision"];
	if (sandboxUnavailableDecision === "allow" || sandboxUnavailableDecision === "deny") {
		result.sandboxUnavailableDecision = sandboxUnavailableDecision;
	}

	const sessionOverride = readSessionOverride(raw["sessionOverride"]);
	if (sessionOverride) {
		result.sessionOverride = sessionOverride;
	}

	const systemPromptInjected = raw["systemPromptInjected"];
	if (typeof systemPromptInjected === "boolean") {
		result.systemPromptInjected = systemPromptInjected;
	}

	const lastCommunicatedHash = raw["lastCommunicatedHash"];
	if (typeof lastCommunicatedHash === "string" && lastCommunicatedHash.length > 0) {
		result.lastCommunicatedHash = lastCommunicatedHash;
	}

	const pending = raw["pendingSandboxNotice"];
	if (isRecord(pending)) {
		const hash = pending["hash"];
		const text = pending["text"];
		if (typeof hash === "string" && typeof text === "string" && !text.includes("allowlist")) {
			result.pendingSandboxNotice = { hash, text };
		}
	}

	const legacyMutationTools = raw["legacyMutationTools"];
	if (Array.isArray(legacyMutationTools)) {
		const nextTools = legacyMutationTools.filter(
			(toolName): toolName is LegacyMutationToolName =>
				toolName === "edit" || toolName === "write",
		);
		if (nextTools.length > 0) {
			result.legacyMutationTools = nextTools;
		}
	}

	return result;
}

function buildSourceHint(): string {
	return "applies to this session";
}

interface SandboxPersistedAccess {
	readonly getSnapshot: () => TauPersistedState;
	readonly update: (patch: Partial<TauPersistedState>) => void;
}

export function getSandboxedBashOperations(
	ctx: ExtensionContext,
	escalate: boolean,
): BashOperations | undefined {
	return getSandboxRuntimeState().createSandboxedBashOperations?.(ctx, escalate);
}

export default function initSandbox(pi: ExtensionAPI, persistence: SandboxPersistedAccess) {
	// Register CLI flags
	pi.registerFlag("sandbox-mode", {
		description: "Sandbox preset (read-only, workspace-write, full-access)",
		type: "string",
	});
	pi.registerFlag("no-sandbox", {
		description: "Completely disable bubblewrap sandbox wrapper (escape hatch)",
		type: "boolean",
	});

	// Track if sandbox is completely disabled via --no-sandbox flag
	let sandboxDisabled = false;

	// First-run: ensure sandbox defaults are written into ~/.pi/agent/settings.json (only fills missing keys).
	ensureUserDefaults();

	let workspaceRoot = process.cwd();
	let sessionState: SessionState = {};
	let effectiveConfig = computeEffectiveConfig({ workspaceRoot });
	let cliOverride: SandboxConfig | undefined;

	function refreshConfig(ctx: ExtensionContext) {
		workspaceRoot = discoverWorkspaceRoot(ctx.cwd);
		const persisted = loadPersistedState(ctx);
		sessionState = loadSessionState(persisted) ?? {};

		// Session overrides come from tau:state; CLI flags override both session and file-based settings.
		const mergedOverride: SandboxConfig = {
			...sessionState.sessionOverride,
			...cliOverride,
		};

		effectiveConfig = computeEffectiveConfig({
			workspaceRoot,
			sessionOverride: mergedOverride,
		});

		const sessionId = ctx.sessionManager.getSessionId();

		updateSandboxRuntimeState({
			workspaceRoot,
			effectiveConfig,
			approvalBroker: getWorkerApprovalBroker(sessionId),
		});

		pi.events.emit("tau:sandbox:changed", effectiveConfig);
	}

	function persistState() {
		persistence.update({ sandbox: sessionStateToPersisted(sessionState) });
	}

	function sameToolNames(left: readonly string[], right: readonly string[]): boolean {
		if (left.length !== right.length) return false;
		for (let index = 0; index < left.length; index += 1) {
			if (left[index] !== right[index]) return false;
		}
		return true;
	}

	function syncMutationToolActivation(provider: string | undefined): void {
		const activeToolNames = pi.getActiveTools();
		const legacySelection = getLegacyMutationToolSelection(activeToolNames);
		if (
			legacySelection.length > 0 &&
			!sameToolNames(legacySelection, sessionState.legacyMutationTools ?? [])
		) {
			sessionState.legacyMutationTools = legacySelection;
			persistState();
		}

		const nextToolNames = rewriteMutationToolNames(activeToolNames, {
			useApplyPatch: shouldUseApplyPatchForProvider(provider),
			legacySelection: sessionState.legacyMutationTools,
		});
		if (!sameToolNames(activeToolNames, nextToolNames)) {
			pi.setActiveTools(nextToolNames);
		}
	}

	function sendSandboxChangeHistoryEntry(text: string): void {
		// UI-only history entry. Must not trigger a new turn.
		pi.sendMessage(
			{
				customType: SANDBOX_CHANGE_MESSAGE_TYPE,
				content: text,
				display: true,
				details: undefined,
			},
			{ triggerTurn: false },
		);
	}

	function queueSandboxChangeNotice(prevHash: string, nextHash: string) {
		// If the effective config didn't change, don't emit anything.
		if (prevHash === nextHash) return;

		// We only emit SANDBOX_CHANGE after we've established initial sandbox state
		// via a first-turn system prompt injection.
		if (!sessionState.systemPromptInjected) return;

		// If we don't know what we last communicated, treat current as baseline.
		if (!sessionState.lastCommunicatedHash) {
			sessionState.lastCommunicatedHash = prevHash;
		}

		// Full circle: back to baseline -> clear pending notice.
		if (nextHash === sessionState.lastCommunicatedHash) {
			sessionState.pendingSandboxNotice = undefined;
			return;
		}

		// Overwrite any previous pending notice: we only want the latest.
		sessionState.pendingSandboxNotice = {
			hash: nextHash,
			text: buildSandboxChangeNoticeText(effectiveConfig),
		};
	}

	function setPreset(preset: SandboxPreset) {
		const prevHash = computeSandboxConfigHash(effectiveConfig);

		sessionState.sessionOverride = { ...sessionState.sessionOverride, preset };
		persistState();

		const mergedOverride: SandboxConfig = {
			...sessionState.sessionOverride,
			...cliOverride,
		};
		effectiveConfig = computeEffectiveConfig({
			workspaceRoot,
			sessionOverride: mergedOverride,
		});

		const nextHash = computeSandboxConfigHash(effectiveConfig);
		queueSandboxChangeNotice(prevHash, nextHash);

		pi.events.emit("tau:sandbox:changed", effectiveConfig);
	}

	function buildSandboxSummary(): string {
		const lines = [
			"Sandbox configuration:",
			`Preset: ${PRESET_LABELS[effectiveConfig.preset]}`,
			`Filesystem: ${effectiveConfig.filesystemMode}`,
			`Network: ${effectiveConfig.networkMode}`,
			`Approval: ${effectiveConfig.approvalPolicy}`,
			`Subagent: ${effectiveConfig.subagent}`,
		];
		return lines.join("\n");
	}

	async function showSandboxSettings(ctx: ExtensionContext) {
		const baselineHash = computeSandboxConfigHash(effectiveConfig);

		if (!ctx.hasUI) {
			pi.sendMessage(
				{
					customType: "sandbox:info",
					content: buildSandboxSummary(),
					display: true,
					details: undefined,
				},
				{ triggerTurn: false },
			);
			return;
		}

		await ctx.ui.custom((tui, theme, _kb, done) => {
			const items: SettingItem[] = [
				{
					id: "preset",
					label: "Sandbox mode",
					currentValue: effectiveConfig.preset,
					values: [...PRESET_VALUES],
					description: buildSourceHint(),
				},
			];

			const container = new Container();
			container.addChild(new Text(theme.fg("accent", theme.bold("Sandbox settings")), 1, 1));

			const settingsList = new SettingsList(
				items,
				Math.min(items.length + 2, 15),
				getSettingsListTheme(),
				(id, newValue) => {
					if (id === "preset") {
						setPreset(newValue as SandboxPreset);
					}

					settingsList.updateValue("preset", effectiveConfig.preset);
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

		const finalHash = computeSandboxConfigHash(effectiveConfig);
		if (finalHash !== baselineHash) {
			// Visible to the user in session history (but filtered out of LLM context).
			sendSandboxChangeHistoryEntry(buildSandboxChangeNoticeText(effectiveConfig));
		}
	}

	const baseBashTool = createBashTool(process.cwd());
	const baseEditTool = createEditTool(process.cwd());
	const baseWriteTool = createWriteTool(process.cwd());

	function singleLine(str: string): string {
		return (str ?? "")
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	}

	async function ensureUnsandboxedAllowedOnSandboxUnavailable(
		ctx: ExtensionContext,
		reason: string,
		timeoutSeconds: number,
	): Promise<boolean> {
		// Cached per-session decision
		if (sessionState.sandboxUnavailableDecision === "allow") return true;
		if (sessionState.sandboxUnavailableDecision === "deny") return false;

		const broker = getSandboxRuntimeState().approvalBroker;
		if (!ctx.hasUI && !broker) {
			// Headless: default deny.
			sessionState.sandboxUnavailableDecision = "deny";
			persistState();
			return false;
		}

		const title = "Sandbox unavailable";
		const message =
			`Sandboxed bash is unavailable.\n\nReason: ${reason}\n\n` +
			"Run bash without sandbox for this session?";
		const timeoutMs = timeoutSeconds * 1000;

		const approved = ctx.hasUI
			? await ctx.ui.confirm(title, message, { timeout: timeoutMs })
			: await broker!.confirm(title, message, { timeoutMs });

		sessionState.sandboxUnavailableDecision = approved ? "allow" : "deny";
		persistState();
		return approved;
	}

	// Factory to create sandboxed bash operations with captured context (avoids global state race conditions)
	function createSandboxedBashOperationsInternal(
		ctx: ExtensionContext,
		escalate: boolean,
	): BashOperations {
		return {
			async exec(command, cwd, { onData, signal, timeout }) {
				// If sandbox is completely disabled, run commands directly
				if (sandboxDisabled) {
					return runCommandDirect(command, cwd, process.env as Record<string, string>, {
						onData,
						signal,
						timeout,
					});
				}

				// Git commands need unsandboxed access for signing (~/.gnupg) and config (~/.gitconfig).
				// Only bypass sandbox for commands that are *purely* git — no chains, pipes, or subshells
				// that could smuggle arbitrary commands outside the sandbox.
				const trimmedCmd = command.trim();
				const hasChaining =
					/[;&|]/.test(trimmedCmd) ||
					/\$\(/.test(trimmedCmd) ||
					/`/.test(trimmedCmd);
				const isGitOnly = !hasChaining && /^git\s/.test(trimmedCmd);
				if (isGitOnly) {
					// Subagent mode: git commands are blocked (orchestrator owns git)
					if (effectiveConfig.subagent) {
						const errorMsg =
							"[sandbox] Git commands are blocked in subagent mode. The orchestrator handles all git operations.\n";
						onData(Buffer.from(errorMsg));
						return { exitCode: 1 };
					}
					return runCommandDirect(command, cwd, process.env as Record<string, string>, {
						onData,
						signal,
						timeout,
					});
				}

				const currentConfig = effectiveConfig;
				const currentWorkspace = workspaceRoot;
				const approvalTimeout = currentConfig.approvalTimeoutSeconds;
				const broker = getSandboxRuntimeState().approvalBroker;

				// Check approval based on policy (using captured ctx)
				const approval = await checkBashApproval(
					ctx,
					currentConfig.approvalPolicy,
					command,
					escalate,
					{ timeoutSeconds: approvalTimeout },
					broker,
				);

				if (!approval.approved) {
					const errorMsg = `Sandbox: command blocked (${approval.reason})\n`;
					onData(Buffer.from(errorMsg));
					return { exitCode: 1 };
				}

				// If approval says run unsandboxed, do that
				if (approval.runUnsandboxed) {
					ctx.ui?.notify?.("Running without sandbox...", "info");
					onData(
						Buffer.from(
							"[sandbox] Running without sandbox restrictions (escalate approved).\n",
						),
					);
					return runCommandDirect(command, cwd, process.env as Record<string, string>, {
						onData,
						signal,
						timeout,
					});
				}

				// Ensure sandbox prerequisites exist. If we can't enforce the sandbox,
				// prompt once per session before falling back to unsandboxed execution.
				const prereqs = detectMissingSandboxDeps({ platform: os.platform() });
				const asrtAvailable = await isAsrtAvailable();

				if (!asrtAvailable || prereqs.missingRequired.length > 0) {
					const parts: string[] = [];
					if (!asrtAvailable) {
						parts.push(getAsrtLoadError() ?? "ASRT module failed to load");
					}
					const depsMsg = formatMissingDepsMessage(prereqs);
					if (depsMsg) parts.push(depsMsg);
					const reason = parts.join("; ");

					const allowUnsandboxed = await ensureUnsandboxedAllowedOnSandboxUnavailable(
						ctx,
						reason,
						approvalTimeout,
					);
					if (!allowUnsandboxed) {
						onData(
							Buffer.from(
								`[sandbox] Sandboxed bash unavailable (${reason}). Refusing to run without sandbox.\n`,
							),
						);
						return { exitCode: 1 };
					}

					onData(
						Buffer.from(
							`[sandbox] Sandboxed bash unavailable (${reason}). Running without sandbox for this session.\n`,
						),
					);
					return runCommandDirect(command, cwd, process.env as Record<string, string>, {
						onData,
						signal,
						timeout,
					});
				}

				// Try to wrap with bwrap
				const wrapResult = await wrapCommandWithSandbox({
					command,
					workspaceRoot: currentWorkspace,
					filesystemMode: currentConfig.filesystemMode,
					networkMode: currentConfig.networkMode,
				});

				if (!wrapResult.success) {
					const reason = singleLine(wrapResult.error);
					const allowUnsandboxed = await ensureUnsandboxedAllowedOnSandboxUnavailable(
						ctx,
						reason,
						approvalTimeout,
					);

					if (!allowUnsandboxed) {
						onData(
							Buffer.from(
								`[sandbox] Failed to start sandbox (${reason}). Refusing to run without sandbox.\n`,
							),
						);
						return { exitCode: 1 };
					}

					onData(
						Buffer.from(
							`[sandbox] Failed to start sandbox (${reason}). Running without sandbox for this session.\n`,
						),
					);
					return runCommandDirect(command, cwd, process.env as Record<string, string>, {
						onData,
						signal,
						timeout,
					});
				}

				const finalCommand = wrapResult.wrappedCommand;
				const env = { ...process.env, HOME: wrapResult.home };
				const usingSandbox = true;

				// Run the command (sandboxed)
				const result = await runCommandCapture(
					finalCommand,
					cwd,
					env as Record<string, string>,
					{ onData, signal, timeout },
				);

				// Emit a best-effort diagnostic when a sandboxed command fails. This helps the model
				// distinguish between genuine command failures and sandbox restrictions.
				if (usingSandbox && result.exitCode !== 0) {
					const classification = classifySandboxFailure(result.output);

					const gatedByConfig =
						classification.kind !== "unknown" &&
						(classification.kind !== "network" ||
							currentConfig.networkMode !== "allow-all") &&
						(classification.kind !== "filesystem" ||
							currentConfig.filesystemMode !== "danger-full-access");

					if (gatedByConfig) {
						const type =
							classification.kind === "network"
								? `network/${classification.subtype}`
								: classification.kind === "filesystem"
									? `filesystem/${classification.subtype}`
									: "unknown";

						const evidence = singleLine(classification.evidence);

						const hint =
							classification.kind === "network"
								? "Network access is blocked by the sandbox. If this command needs network access, retry with escalate=true."
								: classification.kind === "filesystem" &&
									  classification.subtype === "read"
									? "This path may be inside an ephemeral /tmp mount (read-only preset) or outside the allowed workspace. If the file should be readable across calls, retry with escalate=true."
									: classification.kind === "filesystem"
										? "Filesystem write is blocked by the sandbox. If this command needs to write outside the workspace, retry with escalate=true."
										: "";

						onData(
							Buffer.from(
								`[sandbox] Command failed likely due to sandbox restrictions (${type}). (preset=${currentConfig.preset}). Evidence: "${evidence}". ${hint}\n`,
							),
						);

						const diagnostic = {
							usingSandbox: true,
							preset: currentConfig.preset,
							filesystemMode: currentConfig.filesystemMode,
							networkMode: currentConfig.networkMode,
							classification,
						};

						onData(
							Buffer.from(
								`SANDBOX_DIAGNOSTIC=${JSON.stringify(diagnostic)}\n[sandbox] If this failure is caused by sandbox restrictions, retry the same command with escalate=true.\n`,
							),
						);
					}
				}

				// Check if we should offer retry on failure (for "on-failure" policy)
				if (
					result.exitCode !== 0 &&
					usingSandbox &&
					currentConfig.approvalPolicy === "on-failure" &&
					looksLikePolicyViolation(result.output)
				) {
					try {
						const broker = getSandboxRuntimeState().approvalBroker;
						const retryApproval = await requestApprovalAfterFailure(
							ctx,
							command,
							result.output,
							{ timeoutSeconds: approvalTimeout },
							broker,
						);

						if (retryApproval.approved && retryApproval.runUnsandboxed) {
							ctx.ui?.notify?.("Retrying without sandbox...", "info");
							onData(
								Buffer.from(
									"\n[sandbox] User approved retry without sandbox restrictions. Re-running command...\n\n",
								),
							);
							const retryResult = await runCommandDirect(
								command,
								cwd,
								process.env as Record<string, string>,
								{ onData, signal, timeout },
							);
							return { exitCode: retryResult.exitCode };
						}
					} catch (err) {
						console.error("[sandbox] Retry approval failed:", err);
					}
				}

				return { exitCode: result.exitCode };
			},
		};
	}

	updateSandboxRuntimeState({
		createSandboxedBashOperations: createSandboxedBashOperationsInternal,
	});

	// Run command and capture output for policy violation detection
	function runSpawnedCommand(
		cmd: string,
		cwd: string,
		env: Record<string, string>,
		options: { readonly captureOutput: boolean },
		opts: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal | undefined;
			timeout?: number | undefined;
		},
	): Promise<{ exitCode: number | null; output?: string | undefined }> {
		return new Promise((resolve, reject) => {
			if (!existsSync(cwd)) {
				reject(new Error(`Working directory does not exist: ${cwd}`));
				return;
			}

			let outputBuffer = "";
			const { onData, signal, timeout } = opts;

			const child = spawn("bash", ["-lc", cmd], {
				cwd,
				env,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;

			if (timeout !== undefined && timeout > 0) {
				timeoutHandle = setTimeout(() => {
					timedOut = true;
					if (child.pid) {
						killProcessTree(child.pid);
					}
				}, timeout * 1000);
			}

			if (child.stdout) {
				child.stdout.on("data", (data) => {
					if (options.captureOutput) {
						outputBuffer += data.toString();
					}
					onData(data);
				});
			}
			if (child.stderr) {
				child.stderr.on("data", (data) => {
					if (options.captureOutput) {
						outputBuffer += data.toString();
					}
					onData(data);
				});
			}

			child.on("error", (err) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				reject(err);
			});

			const onAbort = () => {
				if (child.pid) {
					killProcessTree(child.pid);
				}
			};

			if (signal) {
				signal.addEventListener("abort", onAbort);
			}

			child.on("close", (code) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
				const exitCode = timedOut ? null : code;

				resolve(
					options.captureOutput
						? { exitCode, output: outputBuffer }
						: { exitCode },
				);
			});
		});
	}

	function runCommandCapture(
		cmd: string,
		cwd: string,
		env: Record<string, string>,
		opts: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal | undefined;
			timeout?: number | undefined;
		},
	): Promise<{ exitCode: number | null; output: string }> {
		return runSpawnedCommand(cmd, cwd, env, { captureOutput: true }, opts).then((result) => ({
			exitCode: result.exitCode,
			output: result.output ?? "",
		}));
	}

	// Run command directly without output capture (for approved/retry runs)
	function runCommandDirect(
		cmd: string,
		cwd: string,
		env: Record<string, string>,
		opts: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal | undefined;
			timeout?: number | undefined;
		},
	): Promise<{ exitCode: number | null }> {
		return runSpawnedCommand(cmd, cwd, env, { captureOutput: false }, opts).then(
			(result) => ({ exitCode: result.exitCode }),
		);
	}
	pi.registerTool({
		...baseBashTool,
		label: "bash",
		promptSnippet: "Execute a bash command in the current working directory",
		promptGuidelines: [
			"Use bash for file operations like ls, rg, find",
			"NEVER use background processes with the & operator in shell commands. Background processes will not continue running and may confuse users.",
		],
		// Extend schema to add escalate parameter
		parameters: Type.Object({
			command: Type.String({ description: "Bash command to execute" }),
			timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional)" })),
			escalate: Type.Optional(
				Type.Boolean({
					description:
						"Request to run without sandbox restrictions. Only use when sandbox is blocking necessary operations.",
				}),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			refreshConfig(ctx);

			const typedParams = params as { command: string; timeout?: number; escalate?: boolean };
			const escalate = typedParams.escalate ?? false;

			// Create tool with operations that capture ctx in closure (no global state)
			const tool = createBashTool(ctx.cwd, {
				operations: createSandboxedBashOperationsInternal(ctx, escalate),
			});

			// Pass params without escalate to inner tool
			const innerParams: { command: string; timeout?: number } = {
				command: typedParams.command,
			};
			if (typedParams.timeout !== undefined) {
				// Heuristic: models RL-trained on codex-rs pass timeout in milliseconds
				// (codex-rs uses timeout_ms) but tau expects seconds. Values above 1800
				// (30 min) are almost certainly milliseconds, so auto-convert.
				if (typedParams.timeout > 1800) {
					const corrected = Math.round(typedParams.timeout / 1000);
					ctx.ui?.notify?.(
						`Timeout ${typedParams.timeout}s looks like ms, using ${corrected}s`,
						"warning",
					);
					innerParams.timeout = corrected;
				} else {
					innerParams.timeout = typedParams.timeout;
				}
			}
			return await tool.execute(toolCallId, innerParams, signal, onUpdate);
		},
	});

	pi.registerTool({
		...baseEditTool,
		label: "edit",
		promptSnippet: "Make surgical edits to files (find exact text and replace)",
		promptGuidelines: ["Use edit for precise changes (old text must match exactly)"],
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			refreshConfig(ctx);
			const targetPath = (params as { path?: string }).path;
			if (targetPath) {
				const check = checkWriteAllowed({
					targetPath,
					workspaceRoot,
					filesystemMode: effectiveConfig.filesystemMode,
				});
				if (!check.allowed) {
					const broker = getSandboxRuntimeState().approvalBroker;
					const approval = await checkFilesystemApproval(
						ctx,
						effectiveConfig.approvalPolicy,
						targetPath,
						"edit",
						{ timeoutSeconds: effectiveConfig.approvalTimeoutSeconds },
						broker,
					);

					if (!approval.approved) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Error: ${check.reason} (${approval.reason})`,
								},
							],
							details: undefined,
						};
					}

					ctx.ui.notify(`Approved: edit ${targetPath}`, "info");
				}
			}
			const tool = createEditTool(ctx.cwd);
			return tool.execute(toolCallId, params, signal);
		},
	});

	pi.registerTool({
		...baseWriteTool,
		label: "write",
		promptSnippet: "Create or overwrite files",
		promptGuidelines: ["Use write only for new files or complete rewrites"],
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			refreshConfig(ctx);
			const targetPath = (params as { path?: string }).path;
			if (targetPath) {
				const check = checkWriteAllowed({
					targetPath,
					workspaceRoot,
					filesystemMode: effectiveConfig.filesystemMode,
				});
				if (!check.allowed) {
					const broker = getSandboxRuntimeState().approvalBroker;
					const approval = await checkFilesystemApproval(
						ctx,
						effectiveConfig.approvalPolicy,
						targetPath,
						"write",
						{ timeoutSeconds: effectiveConfig.approvalTimeoutSeconds },
						broker,
					);

					if (!approval.approved) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Error: ${check.reason} (${approval.reason})`,
								},
							],
							details: undefined,
						};
					}

					ctx.ui.notify(`Approved: write ${targetPath}`, "info");
				}
			}
			const tool = createWriteTool(ctx.cwd);
			return tool.execute(toolCallId, params, signal);
		},
	});

	pi.registerTool(
		createApplyPatchToolDefinition({
			resolveSessionSandboxContext: (ctx) => {
				refreshConfig(ctx);
				return { workspaceRoot, effectiveConfig };
			},
		}),
	);

	pi.on("session_start", async (_event, ctx) => {
		// Check for --no-sandbox escape hatch first
		const noSandbox = pi.getFlag("no-sandbox") as boolean | undefined;
		if (noSandbox) {
			sandboxDisabled = true;
			ctx.ui.notify("Sandbox DISABLED via --no-sandbox flag", "warning");
			refreshConfig(ctx);
			syncMutationToolActivation(ctx.model?.provider);
			return;
		}

		// Apply CLI flag
		const sandboxMode = pi.getFlag("sandbox-mode") as string | undefined;

		if (sandboxMode) {
			const modeMap: Record<string, SandboxPreset> = {
				"read-only": "read-only",
				readonly: "read-only",
				"workspace-write": "workspace-write",
				agent: "workspace-write",
				"full-access": "full-access",
				full: "full-access",
			};
			const mapped = modeMap[sandboxMode.toLowerCase()];
			if (mapped) {
				cliOverride = { preset: mapped };
				ctx.ui.notify(`Sandbox mode: ${PRESET_LABELS[mapped]}`, "info");
			} else {
				ctx.ui.notify(
					`Invalid --sandbox-mode value: ${sandboxMode}. Use: read-only, workspace-write, full-access`,
					"warning",
				);
			}
		}

		refreshConfig(ctx);
		syncMutationToolActivation(ctx.model?.provider);
	});

	pi.on("session_switch", async (_event, ctx) => {
		refreshConfig(ctx);
		syncMutationToolActivation(ctx.model?.provider);
	});

	pi.on("session_tree", async (_event, ctx) => {
		refreshConfig(ctx);
		syncMutationToolActivation(ctx.model?.provider);
	});

	pi.on("session_fork", async (_event, ctx) => {
		refreshConfig(ctx);
		syncMutationToolActivation(ctx.model?.provider);
	});

	pi.on("model_select", async (event) => {
		syncMutationToolActivation(event.model.provider);
	});

	// First turn only: inject initial sandbox state into the system prompt.
	// Subsequent sandbox changes are injected into the user message as content[0]
	// (see context handler below) to preserve provider prompt caching.
	pi.on("before_agent_start", async (event, ctx) => {
		refreshConfig(ctx);

		if (sessionState.systemPromptInjected) return;

		sessionState.systemPromptInjected = true;
		// Don't set lastCommunicatedHash here - let the context hook do it
		// so that SANDBOX_STATE gets injected into the first user message.
		sessionState.pendingSandboxNotice = undefined;
		persistState();

		const injected =
			"<permissions instructions>\n" +
			"Assume all tool calls execute under bubblewrap sandbox restrictions. Do not attempt to bypass restrictions by using other tools.\n" +
			"\n" +
			"Sandbox presets:\n" +
			"  - read-only: filesystem read-only (writes only to ephemeral /tmp), network denied, approval on-request\n" +
			"  - workspace-write: workspace-write (writes to workspace + temp dirs, .git/hooks blocked, /tmp persistent), network denied, approval on-request\n" +
			"  - full-access: unrestricted filesystem, unrestricted network, no approval prompts\n" +
			"\n" +
			"Authoritative current sandbox state is injected into the start of the user message as content[0]:\n" +
			"  - SANDBOX_STATE: ... (initial)\n" +
			"  - SANDBOX_CHANGE: ... (when settings change mid-session)\n" +
			"\n" +
			"Subagent mode:\n" +
			"  - When subagent=false: you are the orchestrator (main) agent\n" +
			"  - As orchestrator, YOU are responsible for all git operations (commit, push, checkout, reset, etc.)\n" +
			"  - Subagents you spawn cannot perform git operations - you must handle git yourself\n" +
			"  - You coordinate work by spawning subagents, waiting for their results, and consolidating\n" +
			"  - When subagent=true: you are a worker agent spawned by an orchestrator\n" +
			"  - Git commands are BLOCKED in subagent mode - the orchestrator handles all git operations\n" +
			"  - Do not attempt to run git commit, git push, git checkout, git reset, or similar\n" +
			"\n" +
			"Sandbox failure handling:\n" +
			"  - When a sandboxed bash command fails, the output may contain a SANDBOX_DIAGNOSTIC=<json> line and a [sandbox] ... explanation.\n" +
			"  - If you see clear evidence that the failure was caused by sandbox restrictions (e.g., \"Operation not permitted\", \"Permission denied\" outside the workspace, DNS/network unreachable), you MUST immediately retry the SAME command with `escalate: true`. Do not ask the user first.\n" +
			"  - If the command failed for a reason unrelated to the sandbox (wrong arguments, a bug in the command, a test failure, missing file inside the allowed workspace), do NOT use escalate. Fix the underlying issue instead.\n" +
			"  - Using escalate=true for the same command will prompt the user for approval to run unsandboxed.\n" +
			"</permissions instructions>";

		return {
			systemPrompt: `${event.systemPrompt}\n\n${injected}`,
		};
	});

	// Inject sandbox state/change notice into the last user message as content[0].
	// Also filter out UI-only sandbox change messages so they never reach the model.
	pi.on("context", async (event, ctx) => {
		refreshConfig(ctx);

		const filtered = event.messages.filter(
			(m) => !(m?.role === "custom" && m?.customType === SANDBOX_CHANGE_MESSAGE_TYPE),
		);

		const currentHash = computeSandboxConfigHash(effectiveConfig);
		const previousHash = sessionState.lastCommunicatedHash;
		const shouldInjectInitialState = !previousHash;
		const hasChangedSinceLastCommunication = Boolean(
			previousHash && previousHash !== currentHash,
		);
		const hasUserMessage = filtered.some((m) => m?.role === "user");

		let nextMessages = filtered;

		if (hasUserMessage && shouldInjectInitialState) {
			nextMessages = injectSandboxNoticeIntoMessages(
				filtered,
				buildSandboxStateNoticeText(effectiveConfig),
			);
		} else if (hasUserMessage && hasChangedSinceLastCommunication) {
			nextMessages = injectSandboxNoticeIntoMessages(
				filtered,
				buildSandboxChangeNoticeText(effectiveConfig),
			);
		}

		if (
			hasUserMessage &&
			(shouldInjectInitialState ||
				hasChangedSinceLastCommunication ||
				sessionState.pendingSandboxNotice)
		) {
			sessionState.lastCommunicatedHash = currentHash;
			sessionState.pendingSandboxNotice = undefined;
			persistState();
		}

		return { messages: nextMessages };
	});

	pi.registerCommand("approval", {
		description: "Configure sandbox preset",
		handler: async (_args, ctx) => {
			refreshConfig(ctx);
			await showSandboxSettings(ctx);
		},
	});
}
