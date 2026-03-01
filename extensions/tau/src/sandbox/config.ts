import { Schema } from "effect";
import * as os from "node:os";
import * as path from "node:path";
import { SandboxConfig as SandboxConfigSchema } from "../schemas/config.js";
import { readJsonFileDetailed, writeJsonFile } from "../shared/fs.js";
import { deepMerge, isRecord, type AnyRecord } from "../shared/json.js";
import {
	type ApprovalPolicy,
	type FilesystemMode,
	type NetworkMode,
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

const decodeSandboxConfig = Schema.decodeUnknownSync(SandboxConfigSchema);

function decodeSandboxConfigOrThrow(value: unknown, source: string): SandboxConfig {
	try {
		const decoded = decodeSandboxConfig(value);
		const normalized: SandboxConfig = {};
		if (decoded.filesystemMode !== undefined) normalized.filesystemMode = decoded.filesystemMode;
		if (decoded.networkMode !== undefined) normalized.networkMode = decoded.networkMode;
		if (decoded.approvalPolicy !== undefined) normalized.approvalPolicy = decoded.approvalPolicy;
		if (decoded.approvalTimeoutSeconds !== undefined) normalized.approvalTimeoutSeconds = decoded.approvalTimeoutSeconds;
		if (decoded.subagent !== undefined) normalized.subagent = decoded.subagent;
		return normalized;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid sandbox config at ${source}: ${reason}`);
	}
}

export function applyDefaults(cfg: SandboxConfig | undefined): Required<SandboxConfig> {
	return {
		filesystemMode: cfg?.filesystemMode ?? DEFAULT_SANDBOX_CONFIG.filesystemMode,
		networkMode: cfg?.networkMode ?? DEFAULT_SANDBOX_CONFIG.networkMode,
		approvalPolicy: cfg?.approvalPolicy ?? DEFAULT_SANDBOX_CONFIG.approvalPolicy,
		approvalTimeoutSeconds: cfg?.approvalTimeoutSeconds ?? DEFAULT_SANDBOX_CONFIG.approvalTimeoutSeconds,
		subagent: cfg?.subagent ?? DEFAULT_SANDBOX_CONFIG.subagent,
	};
}

function readSandboxNamespace(settings: AnyRecord, settingsPath: string): SandboxConfig {
	// New namespace: settings.tau.sandbox
	const tau = settings["tau"];
	const tauSandbox = isRecord(tau) ? tau["sandbox"] : undefined;
	if (tauSandbox !== undefined) {
		return decodeSandboxConfigOrThrow(tauSandbox, `${settingsPath}: tau.sandbox`);
	}

	// Back-compat: settings.sandbox
	const legacy = settings["sandbox"];
	if (legacy !== undefined) {
		return decodeSandboxConfigOrThrow(legacy, `${settingsPath}: sandbox`);
	}
	return {};
}

function readSettingsFileOrThrow(settingsPath: string): AnyRecord {
	const result = readJsonFileDetailed(settingsPath);
	if (result._tag === "missing") return {};
	if (result._tag === "ok") return result.data;
	throw new Error(`Invalid settings JSON at ${settingsPath}: ${result.reason}`);
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
	const current = readSettingsFileOrThrow(settingsPath);
	const existing = readSandboxNamespace(current, settingsPath);
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
	const userSettingsPath = getUserSettingsPath();
	const projectSettingsPath = getProjectSettingsPath(opts.workspaceRoot);
	const userSettings = readSettingsFileOrThrow(userSettingsPath);
	const projectSettings = readSettingsFileOrThrow(projectSettingsPath);

	const userSandbox = readSandboxNamespace(userSettings, userSettingsPath);
	const projectSandbox = readSandboxNamespace(projectSettings, projectSettingsPath);

	// precedence: session > project > user
	const merged = decodeSandboxConfigOrThrow(
		deepMerge(deepMerge(userSandbox, projectSandbox), opts.sessionOverride ?? {}),
		"effective sandbox config",
	);
	return applyDefaults(merged);
}

export function persistUserConfigPatch(patch: SandboxConfig): void {
	const settingsPath = getUserSettingsPath();
	const current = readSettingsFileOrThrow(settingsPath);
	const existing = readSandboxNamespace(current, settingsPath);
	const nextSandbox = decodeSandboxConfigOrThrow(
		deepMerge(existing, decodeSandboxConfigOrThrow(patch, "user sandbox patch")),
		"user sandbox config",
	);
	const currentTau = isRecord(current["tau"]) ? current["tau"] : {};
	const merged = deepMerge(current, { tau: { ...currentTau, sandbox: nextSandbox } });
	writeJsonFile(settingsPath, merged);
}

export function persistProjectConfigPatch(workspaceRoot: string, patch: SandboxConfig): void {
	const settingsPath = getProjectSettingsPath(workspaceRoot);
	const current = readSettingsFileOrThrow(settingsPath);
	const existing = readSandboxNamespace(current, settingsPath);
	const nextSandbox = decodeSandboxConfigOrThrow(
		deepMerge(existing, decodeSandboxConfigOrThrow(patch, "project sandbox patch")),
		"project sandbox config",
	);
	const currentTau = isRecord(current["tau"]) ? current["tau"] : {};
	const merged = deepMerge(current, { tau: { ...currentTau, sandbox: nextSandbox } });
	writeJsonFile(settingsPath, merged);
}
