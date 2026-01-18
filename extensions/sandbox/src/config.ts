import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type FilesystemMode = "read-only" | "workspace-write" | "danger-full-access";
export type NetworkMode = "deny" | "allowlist" | "allow-all";
export type ApprovalPolicy = "never" | "on-failure" | "on-request" | "unless-trusted";

export type SandboxConfig = {
	filesystemMode?: FilesystemMode;
	networkMode?: NetworkMode;
	networkAllowlist?: string[];
	approvalPolicy?: ApprovalPolicy;
	approvalTimeoutSeconds?: number;
};

export const DEFAULT_SANDBOX_CONFIG: Required<SandboxConfig> = {
	filesystemMode: "workspace-write",
	networkMode: "deny",
	networkAllowlist: [],
	approvalPolicy: "on-failure",
	approvalTimeoutSeconds: 60,
};

/** Migrate deprecated policy values to current ones */
function migrateApprovalPolicy(policy: string | undefined): ApprovalPolicy | undefined {
	if (!policy) return undefined;
	// "ask" was removed - closest equivalent is "unless-trusted" (prompts for unsafe commands)
	if (policy === "ask") return "unless-trusted";
	return policy as ApprovalPolicy;
}

export function applyDefaults(cfg: SandboxConfig | undefined): Required<SandboxConfig> {
	return {
		filesystemMode: cfg?.filesystemMode ?? DEFAULT_SANDBOX_CONFIG.filesystemMode,
		networkMode: cfg?.networkMode ?? DEFAULT_SANDBOX_CONFIG.networkMode,
		networkAllowlist: cfg?.networkAllowlist ?? DEFAULT_SANDBOX_CONFIG.networkAllowlist,
		approvalPolicy: migrateApprovalPolicy(cfg?.approvalPolicy as string) ?? DEFAULT_SANDBOX_CONFIG.approvalPolicy,
		approvalTimeoutSeconds: cfg?.approvalTimeoutSeconds ?? DEFAULT_SANDBOX_CONFIG.approvalTimeoutSeconds,
	};
}

function readJsonFile(filePath: string): any | undefined {
	try {
		if (!fs.existsSync(filePath)) return undefined;
		const raw = fs.readFileSync(filePath, "utf-8");
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

function writeJsonFile(filePath: string, obj: any): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + "\n", "utf-8");
}

/** Deep merge for plain objects; arrays are replaced. */
function deepMerge(base: any, override: any): any {
	if (override === undefined) return base;
	if (base === undefined) return override;
	if (typeof base !== "object" || base === null || Array.isArray(base)) return override;
	if (typeof override !== "object" || override === null || Array.isArray(override)) return override;
	const out: any = { ...base };
	for (const [k, v] of Object.entries(override)) {
		if (v === undefined) continue;
		out[k] = deepMerge((base as any)[k], v);
	}
	return out;
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
	const existing = (current.sandbox ?? {}) as SandboxConfig;
	const withDefaults = applyDefaults(existing);

	const needsWrite =
		current.sandbox === undefined ||
		existing.filesystemMode === undefined ||
		existing.networkMode === undefined ||
		existing.networkAllowlist === undefined ||
		existing.approvalPolicy === undefined ||
		existing.approvalTimeoutSeconds === undefined;

	if (!needsWrite) return;
	const merged = deepMerge(current, { sandbox: withDefaults });
	writeJsonFile(settingsPath, merged);
}

export function computeEffectiveConfig(opts: {
	workspaceRoot: string;
	sessionOverride?: SandboxConfig;
}): Required<SandboxConfig> {
	const userSettings = readJsonFile(getUserSettingsPath()) ?? {};
	const projectSettings = readJsonFile(getProjectSettingsPath(opts.workspaceRoot)) ?? {};

	const userSandbox = (userSettings.sandbox ?? {}) as SandboxConfig;
	const projectSandbox = (projectSettings.sandbox ?? {}) as SandboxConfig;

	// precedence: session > project > user
	const merged = deepMerge(deepMerge(userSandbox, projectSandbox), opts.sessionOverride ?? {});
	return applyDefaults(merged);
}

export function persistUserConfigPatch(patch: SandboxConfig): void {
	const settingsPath = getUserSettingsPath();
	const current = readJsonFile(settingsPath) ?? {};
	const nextSandbox = deepMerge(current.sandbox ?? {}, patch);
	const merged = deepMerge(current, { sandbox: nextSandbox });
	writeJsonFile(settingsPath, merged);
}
