import { Schema } from "effect";

export const FilesystemMode = Schema.Literal("read-only", "workspace-write", "danger-full-access");
export type FilesystemMode = Schema.Schema.Type<typeof FilesystemMode>;

export const NetworkMode = Schema.Literal("deny", "allow-all");
export type NetworkMode = Schema.Schema.Type<typeof NetworkMode>;

export const ApprovalPolicy = Schema.Literal("never", "on-failure", "on-request", "unless-trusted");
export type ApprovalPolicy = Schema.Schema.Type<typeof ApprovalPolicy>;

export const ApprovalTimeoutSeconds = Schema.Number.pipe(
	Schema.filter((value) => Number.isFinite(value) && Number.isInteger(value) && value > 0),
);
export type ApprovalTimeoutSeconds = Schema.Schema.Type<typeof ApprovalTimeoutSeconds>;

export const SandboxConfig = Schema.Struct({
	filesystemMode: Schema.optional(FilesystemMode),
	networkMode: Schema.optional(NetworkMode),
	approvalPolicy: Schema.optional(ApprovalPolicy),
	approvalTimeoutSeconds: Schema.optional(ApprovalTimeoutSeconds),
	subagent: Schema.optional(Schema.Boolean),
});
export type SandboxConfig = Schema.Schema.Type<typeof SandboxConfig>;

export const SandboxConfigRequired = Schema.Struct({
	filesystemMode: FilesystemMode,
	networkMode: NetworkMode,
	approvalPolicy: ApprovalPolicy,
	approvalTimeoutSeconds: ApprovalTimeoutSeconds,
	subagent: Schema.Boolean,
});
export type SandboxConfigRequired = Schema.Schema.Type<typeof SandboxConfigRequired>;
