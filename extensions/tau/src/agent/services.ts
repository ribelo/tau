import { Context, Data, Effect } from "effect";
import type { AgentId, ResolvedPolicy } from "./types.js";
import type { Status } from "./status.js";
export type { Status };
import type { SandboxConfig } from "../sandbox/config.js";
import type { ApprovalBroker } from "./approval-broker.js";

// Error Types
export class AgentNotFound extends Data.TaggedError("AgentNotFound")<{
	readonly id: AgentId;
}> {}
export class AgentLimitReached extends Data.TaggedError("AgentLimitReached")<{
	readonly max: number;
}> {}
export class AgentDepthExceeded extends Data.TaggedError("AgentDepthExceeded")<{
	readonly max: number;
}> {}
export class AgentAlreadyShutdown extends Data.TaggedError("AgentAlreadyShutdown")<{
	readonly id: AgentId;
}> {}
export class ManagerDropped extends Data.TaggedError("ManagerDropped")<{}> {}
export class AgentError extends Data.TaggedError("AgentError")<{
	readonly message: string;
}> {}

// Config
export interface AgentConfigService {
	readonly maxThreads: number;
	readonly maxDepth: number;
}

export class AgentConfig extends Context.Tag("AgentConfig")<
	AgentConfig,
	AgentConfigService
>() {}

// Agent Info
export interface AgentInfo {
	readonly id: AgentId;
	readonly type: string;
	readonly status: Status;
}

// Agent Worker Interface
export interface Agent {
	readonly id: AgentId;
	readonly type: string;
	readonly depth: number;
	readonly prompt: (message: string) => Effect.Effect<string, AgentError>; // returns submission_id
	readonly interrupt: () => Effect.Effect<void>;
	readonly shutdown: () => Effect.Effect<void>;
	readonly status: Effect.Effect<Status>;
	readonly subscribeStatus: () => any; // Will be a Stream or similar
}

// Agent Manager
export interface SpawnOptions {
	readonly type: string;
	readonly policy: ResolvedPolicy;
	readonly message: string;
	readonly depth: number;
	readonly cwd: string;
	readonly parentSessionId: string;
	readonly parentSandboxConfig: Required<SandboxConfig>;
	readonly approvalBroker?: ApprovalBroker | undefined;
	readonly resultSchema?: unknown;
}

export class AgentManager extends Context.Tag("AgentManager")<
	AgentManager,
	{
		readonly spawn: (
			opts: SpawnOptions,
		) => Effect.Effect<
			AgentId,
			AgentLimitReached | AgentDepthExceeded | AgentError
		>;
		readonly get: (id: AgentId) => Effect.Effect<Agent, AgentNotFound>;
		readonly list: Effect.Effect<AgentInfo[]>;
		readonly shutdown: (id: AgentId) => Effect.Effect<void, AgentNotFound>;
	}
>() {}

// Agent Control
export interface ControlSpawnOptions {
	readonly type: string;
	readonly message: string;
	readonly complexity?: string | undefined;
	readonly skills?: string[] | undefined;
	readonly result_schema?: unknown;
	readonly approvalBroker?: ApprovalBroker | undefined;
	readonly parentSessionId: string;
	readonly cwd: string;
}

export class AgentControl extends Context.Tag("AgentControl")<
	AgentControl,
	{
		readonly spawn: (
			opts: ControlSpawnOptions,
		) => Effect.Effect<
			AgentId,
			AgentLimitReached | AgentDepthExceeded | AgentError
		>;
		readonly send: (
			id: AgentId,
			message: string,
			interrupt?: boolean,
		) => Effect.Effect<string, AgentNotFound | AgentError>;
		readonly wait: (
			ids: AgentId[],
			timeoutMs?: number,
		) => Effect.Effect<
			{ status: Record<AgentId, Status>; timedOut: boolean },
			any,
			any
		>;
		readonly close: (id: AgentId) => Effect.Effect<void, AgentNotFound>;
		readonly list: Effect.Effect<AgentInfo[]>;
	}
>() {}
