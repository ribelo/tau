export type FilesystemMode = "read-only" | "workspace-write" | "danger-full-access";
export type NetworkMode = "deny" | "allowlist" | "allow-all";
export type ApprovalPolicy = "never" | "on-failure" | "on-request" | "unless-trusted";

export const FILESYSTEM_MODES: readonly FilesystemMode[] = ["read-only", "workspace-write", "danger-full-access"] as const;
export const NETWORK_MODES: readonly NetworkMode[] = ["deny", "allowlist", "allow-all"] as const;
export const APPROVAL_POLICIES: readonly ApprovalPolicy[] = ["never", "on-failure", "on-request", "unless-trusted"] as const;

/** Migrate deprecated policy values to current ones */
export function migrateApprovalPolicy(policy: string | undefined): ApprovalPolicy | undefined {
	if (!policy) return undefined;
	const trimmed = policy.trim();
	if (!trimmed) return undefined;

	// "ask" was removed - closest equivalent is "unless-trusted" (prompts for unsafe commands)
	if (trimmed === "ask") return "unless-trusted";

	if (APPROVAL_POLICIES.includes(trimmed as ApprovalPolicy)) {
		return trimmed as ApprovalPolicy;
	}

	return undefined;
}
