import * as os from "node:os";
import * as path from "node:path";
import { readJsonFile, writeJsonFile } from "../shared/fs.js";
import { deepMerge, isRecord } from "../shared/json.js";
import {
	type ApprovalPolicy,
	type FilesystemMode,
	type NetworkMode,
	migrateApprovalPolicy,
	migrateNetworkMode,
} from "../shared/policy.js";

export type { ApprovalPolicy, FilesystemMode, NetworkMode };

export type SandboxConfig = {
	filesystemMode?: FilesystemMode;
	networkMode?: NetworkMode;
	approvalPolicy?: ApprovalPolicy;
	approvalTimeoutSeconds?: number;
};

export const DEFAULT_SANDBOX_CONFIG: Required<SandboxConfig> = {
	filesystemMode: "workspace-write",
	networkMode: "deny",
	approvalPolicy: "on-failure",
	approvalTimeoutSeconds: 60,
};

export function applyDefaults(cfg: SandboxConfig | undefined): Required<SandboxConfig> {
	return {
		filesystemMode: cfg?.filesystemMode ?? DEFAULT_SANDBOX_CONFIG.filesystemMode,
		networkMode: migrateNetworkMode(cfg?.networkMode) ?? DEFAULT_SANDBOX_CONFIG.networkMode,
		approvalPolicy: migrateApprovalPolicy(cfg?.approvalPolicy) ?? DEFAULT_SANDBOX_CONFIG.approvalPolicy,
		approvalTimeoutSeconds: cfg?.approvalTimeoutSeconds ?? DEFAULT_SANDBOX_CONFIG.approvalTimeoutSeconds,
	};
}

function readSandboxNamespace(settings: unknown): SandboxConfig {
	if (!isRecord(settings)) return {};
	// New namespace: settings.tau.sandbox
	const tau = settings.tau;
	const tauSandbox = isRecord(tau) ? tau.sandbox : undefined;
	if (isRecord(tauSandbox)) return tauSandbox as SandboxConfig;

	// Back-compat: settings.sandbox
	const legacy = settings.sandbox;
	if (isRecord(legacy)) return legacy as SandboxConfig;
	return {};
}

export function getUserSettingsPath(): string {
	// Allow override for tests.
	if (process.env.TAU_SANDBOX_USER_SETTINGS_PATH) {
		return process.env.TAU_SANDBOX_USER_SETTINGS_PATH;
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

	const needsWrite =
		current.tau?.sandbox === undefined ||
		existing.filesystemMode === undefined ||
		existing.networkMode === undefined ||
		existing.approvalPolicy === undefined ||
		existing.approvalTimeoutSeconds === undefined;

	if (!needsWrite) return;
	const merged = deepMerge(current, { tau: { ...(current.tau ?? {}), sandbox: withDefaults } });
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
	const merged = deepMerge(current, { tau: { ...(current.tau ?? {}), sandbox: nextSandbox } });
	writeJsonFile(settingsPath, merged);
}
