import { Context, Data, Effect, Stream } from "effect";
import type { Model, Api } from "@mariozechner/pi-ai";
import type { AgentId, AgentDefinition } from "./types.js";
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
export class ManagerDropped extends Data.TaggedError("ManagerDropped")<{
	readonly message?: string;
}> {}
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
	readonly subscribeStatus: () => Stream.Stream<Status>;
}

// Agent Manager
export interface SpawnOptions {
	readonly definition: AgentDefinition;
	readonly message: string;
	readonly depth: number;
	readonly cwd: string;
	readonly parentSessionId: string;
	readonly parentSandboxConfig: Required<SandboxConfig>;
	readonly parentModel?: Model<Api> | undefined;
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
		readonly shutdownAll: Effect.Effect<void>;
	}
>() {}

// Agent Control
export interface ControlSpawnOptions {
	readonly agent: string;
	readonly message: string;
	readonly complexity?: string | undefined;
	readonly result_schema?: unknown;
	readonly approvalBroker?: ApprovalBroker | undefined;
	readonly parentSessionId: string;
	readonly parentModel?: Model<Api> | undefined;
	readonly cwd: string;
}

/** Result type for wait operations */
export interface WaitResult {
	readonly status: Record<AgentId, Status>;
	readonly timedOut: boolean;
	/** Map of agent id to agent type/name */
	readonly agentTypes?: Record<AgentId, string>;
	/** True if wait was interrupted by user */
	readonly interrupted?: boolean;
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
		) => Effect.Effect<WaitResult, unknown>;
		/** Stream version of wait that emits status updates */
		readonly waitStream: (
			ids: AgentId[],
			timeoutMs?: number,
			pollIntervalMs?: number,
		) => Stream.Stream<WaitResult, unknown>;
		readonly close: (id: AgentId) => Effect.Effect<void, AgentNotFound>;
		readonly closeAll: Effect.Effect<void>;
		readonly list: Effect.Effect<AgentInfo[]>;
	}
>() {}
