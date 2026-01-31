export type FilesystemMode = "read-only" | "workspace-write" | "danger-full-access";
export type NetworkMode = "deny" | "allow-all";
export type ApprovalPolicy = "never" | "on-failure" | "on-request" | "unless-trusted";

export const FILESYSTEM_MODES: readonly FilesystemMode[] = ["read-only", "workspace-write", "danger-full-access"] as const;
export const NETWORK_MODES: readonly NetworkMode[] = ["deny", "allow-all"] as const;
export const APPROVAL_POLICIES: readonly ApprovalPolicy[] = ["never", "on-failure", "on-request", "unless-trusted"] as const;

