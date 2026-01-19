import type { ApprovalPolicy, FilesystemMode, NetworkMode, SandboxConfig } from "../sandbox/config.js";
import { normalizeAllowlist, intersectAllowlist } from "../shared/allowlist.js";

const FILESYSTEM_RANK: Record<FilesystemMode, number> = {
	"read-only": 0,
	"workspace-write": 1,
	"danger-full-access": 2,
};

const NETWORK_RANK: Record<NetworkMode, number> = {
	deny: 0,
	allowlist: 1,
	"allow-all": 2,
};

// Ordering requested by tau-iqa (match codex-rs semantics).
const APPROVAL_RANK: Record<ApprovalPolicy, number> = {
	"unless-trusted": 0,
	never: 1,
	"on-request": 2,
	"on-failure": 3,
};

function minByRank<T extends string>(a: T, b: T, rank: Record<T, number>): T {
	return rank[a] <= rank[b] ? a : b;
}

/**
 * Compute a worker sandbox config that:
 * - inherits missing fields from the parent
 * - clamps requested values so the worker is never more permissive than the parent
 */
export function computeClampedWorkerSandboxConfig(options: {
	parent: Required<SandboxConfig>;
	requested?: SandboxConfig;
}): Required<SandboxConfig> {
	const requested: Required<SandboxConfig> = {
		filesystemMode: options.requested?.filesystemMode ?? options.parent.filesystemMode,
		networkMode: options.requested?.networkMode ?? options.parent.networkMode,
		networkAllowlist:
			options.requested?.networkAllowlist !== undefined
				? normalizeAllowlist(options.requested.networkAllowlist)
				: normalizeAllowlist(options.parent.networkAllowlist),
		approvalPolicy: options.requested?.approvalPolicy ?? options.parent.approvalPolicy,
		approvalTimeoutSeconds: options.requested?.approvalTimeoutSeconds ?? options.parent.approvalTimeoutSeconds,
	};

	const filesystemMode = minByRank(requested.filesystemMode, options.parent.filesystemMode, FILESYSTEM_RANK);
	const networkMode = minByRank(requested.networkMode, options.parent.networkMode, NETWORK_RANK);
	const approvalPolicy = minByRank(requested.approvalPolicy, options.parent.approvalPolicy, APPROVAL_RANK);
	const approvalTimeoutSeconds = Math.min(requested.approvalTimeoutSeconds, options.parent.approvalTimeoutSeconds);

	let networkAllowlist = normalizeAllowlist(requested.networkAllowlist);

	if (networkMode !== "allowlist") {
		networkAllowlist = [];
	} else {
		if (options.parent.networkMode === "deny") {
			networkAllowlist = [];
		} else if (options.parent.networkMode === "allowlist") {
			networkAllowlist = intersectAllowlist(normalizeAllowlist(options.parent.networkAllowlist), networkAllowlist);
		}
	}

	return {
		filesystemMode,
		networkMode,
		networkAllowlist,
		approvalPolicy,
		approvalTimeoutSeconds,
	};
}

