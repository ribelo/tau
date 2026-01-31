import * as os from "node:os";
import * as path from "node:path";
import { readJsonFile, writeJsonFile } from "../shared/fs.js";
import { deepMerge, isRecord } from "../shared/json.js";
import {
	type ApprovalPolicy,
	type FilesystemMode,
	type NetworkMode,
	APPROVAL_POLICIES,
	NETWORK_MODES,
} from "../shared/policy.js";

export type { ApprovalPolicy, FilesystemMode, NetworkMode };

export type SandboxConfig = {
	filesystemMode?: FilesystemMode;
	networkMode?: NetworkMode;
	approvalPolicy?: ApprovalPolicy;
	approvalTimeoutSeconds?: number;
	/** If true, agent is running in subagent mode (blocks git, restricted operations) */
	subagent?: boolean;
};

export const DEFAULT_SANDBOX_CONFIG: Required<SandboxConfig> = {
	filesystemMode: "workspace-write",
	networkMode: "allow-all",
	approvalPolicy: "on-failure",
	approvalTimeoutSeconds: 60,
	subagent: false,
};

export function applyDefaults(cfg: SandboxConfig | undefined): Required<SandboxConfig> {
	const networkMode =
		cfg?.networkMode && NETWORK_MODES.includes(cfg.networkMode)
			? cfg.networkMode
			: DEFAULT_SANDBOX_CONFIG.networkMode;
	const approvalPolicy =
		cfg?.approvalPolicy && APPROVAL_POLICIES.includes(cfg.approvalPolicy)
			? cfg.approvalPolicy
			: DEFAULT_SANDBOX_CONFIG.approvalPolicy;

	return {
		filesystemMode: cfg?.filesystemMode ?? DEFAULT_SANDBOX_CONFIG.filesystemMode,
		networkMode,
		approvalPolicy,
		approvalTimeoutSeconds: cfg?.approvalTimeoutSeconds ?? DEFAULT_SANDBOX_CONFIG.approvalTimeoutSeconds,
		subagent: cfg?.subagent ?? DEFAULT_SANDBOX_CONFIG.subagent,
	};
}

function readSandboxNamespace(settings: unknown): SandboxConfig {
	if (!isRecord(settings)) return {};
	// New namespace: settings.tau.sandbox
	const tau = settings["tau"];
	const tauSandbox = isRecord(tau) ? tau["sandbox"] : undefined;
	if (isRecord(tauSandbox)) return tauSandbox as SandboxConfig;

	// Back-compat: settings.sandbox
	const legacy = settings["sandbox"];
	if (isRecord(legacy)) return legacy as SandboxConfig;
	return {};
}

export function getUserSettingsPath(): string {
	// Allow override for tests.
	const override = process.env["TAU_SANDBOX_USER_SETTINGS_PATH"];
	if (override) {
		return override;
	}
	return path.join(os.homedir(), ".pi", "agent", "settings.json");
}

export function getProjectSettingsPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, ".pi", "settings.json");
}

/**
 * Ensure sandbox defaults exist in user settings file.
 * Does not override existing values; only fills missing keys.
 */
export function ensureUserDefaults(): void {
	const settingsPath = getUserSettingsPath();
	const current = readJsonFile(settingsPath) ?? {};
	const existing = readSandboxNamespace(current);
	const withDefaults = applyDefaults(existing);

	const currentTau = isRecord(current["tau"]) ? current["tau"] : undefined;
	const needsWrite =
		currentTau?.["sandbox"] === undefined ||
		existing.filesystemMode === undefined ||
		existing.networkMode === undefined ||
		existing.approvalPolicy === undefined ||
		existing.approvalTimeoutSeconds === undefined;

	if (!needsWrite) return;
	const merged = deepMerge(current, { tau: { ...(currentTau ?? {}), sandbox: withDefaults } });
	writeJsonFile(settingsPath, merged);
}

export function computeEffectiveConfig(opts: {
	workspaceRoot: string;
	sessionOverride?: SandboxConfig;
}): Required<SandboxConfig> {
	const userSettings = readJsonFile(getUserSettingsPath()) ?? {};
	const projectSettings = readJsonFile(getProjectSettingsPath(opts.workspaceRoot)) ?? {};

	const userSandbox = readSandboxNamespace(userSettings);
	const projectSandbox = readSandboxNamespace(projectSettings);

	// precedence: session > project > user
	const merged = deepMerge(deepMerge(userSandbox, projectSandbox), opts.sessionOverride ?? {});
	return applyDefaults(merged);
}

export function persistUserConfigPatch(patch: SandboxConfig): void {
	const settingsPath = getUserSettingsPath();
	const current = readJsonFile(settingsPath) ?? {};
	const existing = readSandboxNamespace(current);
	const nextSandbox = deepMerge(existing, patch);
	const currentTau = isRecord(current["tau"]) ? current["tau"] : {};
	const merged = deepMerge(current, { tau: { ...currentTau, sandbox: nextSandbox } });
	writeJsonFile(settingsPath, merged);
}

export function persistProjectConfigPatch(workspaceRoot: string, patch: SandboxConfig): void {
	const settingsPath = getProjectSettingsPath(workspaceRoot);
	const current = readJsonFile(settingsPath) ?? {};
	const existing = readSandboxNamespace(current);
	const nextSandbox = deepMerge(existing, patch);
	const currentTau = isRecord(current["tau"]) ? current["tau"] : {};
	const merged = deepMerge(current, { tau: { ...currentTau, sandbox: nextSandbox } });
	writeJsonFile(settingsPath, merged);
}
