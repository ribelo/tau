import { Schema } from "@effect/schema";

export const FilesystemMode = Schema.Literal("read-only", "workspace-write", "danger-full-access");
export type FilesystemMode = Schema.Schema.Type<typeof FilesystemMode>;

export const NetworkMode = Schema.Literal("deny", "allow-all");
export type NetworkMode = Schema.Schema.Type<typeof NetworkMode>;

export const ApprovalPolicy = Schema.Literal("never", "on-failure", "on-request", "unless-trusted");
export type ApprovalPolicy = Schema.Schema.Type<typeof ApprovalPolicy>;

export const SandboxConfig = Schema.Struct({
	filesystemMode: Schema.optional(FilesystemMode),
	networkMode: Schema.optional(NetworkMode),
	approvalPolicy: Schema.optional(ApprovalPolicy),
	approvalTimeoutSeconds: Schema.optional(Schema.Number),
});
export type SandboxConfig = Schema.Schema.Type<typeof SandboxConfig>;

export const SandboxConfigRequired = Schema.Struct({
	filesystemMode: FilesystemMode,
	networkMode: NetworkMode,
	approvalPolicy: ApprovalPolicy,
	approvalTimeoutSeconds: Schema.Number,
});
export type SandboxConfigRequired = Schema.Schema.Type<typeof SandboxConfigRequired>;
