import { Schema } from "effect";

const FilesystemMode = Schema.Literals([
	"read-only",
	"workspace-write",
	"danger-full-access",
]);
type FilesystemMode = Schema.Schema.Type<typeof FilesystemMode>;

const NetworkMode = Schema.Literals(["deny", "allow-all"]);
type NetworkMode = Schema.Schema.Type<typeof NetworkMode>;

const ApprovalPolicy = Schema.Literals([
	"never",
	"on-failure",
	"on-request",
	"unless-trusted",
]);
type ApprovalPolicy = Schema.Schema.Type<typeof ApprovalPolicy>;

export const ApprovalTimeoutSeconds = Schema.Number.check(
	Schema.isFinite(),
	Schema.isInt(),
	Schema.isGreaterThan(0),
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
