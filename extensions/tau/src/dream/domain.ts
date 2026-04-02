import { Schema } from "effect";

import { MemoryEntryId, type MemoryEntriesSnapshot } from "../memory/format.js";
import type { MutationResult } from "../services/curated-memory.js";

export const DreamRunMode = Schema.Literals(["manual", "auto"]);
export type DreamRunMode = typeof DreamRunMode.Type;

export const DreamPhase = Schema.Literals([
	"queued",
	"orient",
	"gather",
	"consolidate",
	"prune",
	"apply",
	"done",
]);
export type DreamPhase = typeof DreamPhase.Type;

export const DreamTaskStatus = Schema.Literals([
	"running",
	"completed",
	"failed",
	"cancelled",
]);
export type DreamTaskStatus = typeof DreamTaskStatus.Type;

export const DreamMemoryScope = Schema.Literals(["project", "global", "user"]);
export type DreamMemoryScope = typeof DreamMemoryScope.Type;

export const DreamTaskId = Schema.String;
export type DreamTaskId = typeof DreamTaskId.Type;

export interface DreamTranscriptCandidate {
	readonly sessionId: string;
	readonly path: string;
	readonly touchedAt: number;
}

export interface DreamAutoPermit {
	readonly sinceMs: number;
	readonly sessions: ReadonlyArray<DreamTranscriptCandidate>;
}

export interface DreamRunRequest {
	readonly cwd: string;
	readonly mode: DreamRunMode;
	readonly currentSessionId?: string;
	readonly requestedBy: "user" | "scheduler";
}

export interface DreamTaskHandle {
	readonly taskId: DreamTaskId;
}

export type DreamProgressEvent =
	| {
			readonly _tag: "PhaseChanged";
			readonly phase: DreamPhase;
			readonly message?: string;
	  }
	| {
			readonly _tag: "SessionsDiscovered";
			readonly total: number;
	  }
	| {
			readonly _tag: "SessionsReviewed";
			readonly reviewed: number;
			readonly total: number;
	  }
	| {
			readonly _tag: "OperationsPlanned";
			readonly total: number;
	  }
	| {
			readonly _tag: "OperationApplied";
			readonly applied: number;
			readonly total: number;
			readonly summary: string;
	  }
	| {
			readonly _tag: "Note";
			readonly text: string;
	  };

export interface DreamTaskState {
	readonly id: DreamTaskId;
	readonly type: "dream";
	readonly mode: DreamRunMode;
	readonly status: DreamTaskStatus;
	readonly phase: DreamPhase;
	readonly startedAt: number;
	readonly finishedAt?: number;
	readonly sessionsDiscovered: number;
	readonly sessionsReviewed: number;
	readonly operationsPlanned: number;
	readonly operationsApplied: number;
	readonly latestMessage?: string;
	readonly cancellable: boolean;
}

export const DreamAddOperation = Schema.Struct({
	_tag: Schema.Literal("add"),
	scope: DreamMemoryScope,
	content: Schema.String,
	rationale: Schema.String,
});

export const DreamUpdateOperation = Schema.Struct({
	_tag: Schema.Literal("update"),
	scope: DreamMemoryScope,
	id: MemoryEntryId,
	content: Schema.String,
	rationale: Schema.String,
});

export const DreamRemoveOperation = Schema.Struct({
	_tag: Schema.Literal("remove"),
	scope: DreamMemoryScope,
	id: MemoryEntryId,
	rationale: Schema.String,
});

export const DreamMutation = Schema.Union([
	DreamAddOperation,
	DreamUpdateOperation,
	DreamRemoveOperation,
]);
export type DreamMutation = typeof DreamMutation.Type;

export const DreamConsolidationPlan = Schema.Struct({
	summary: Schema.String,
	reviewedSessions: Schema.Array(Schema.String),
	pruneNotes: Schema.Array(Schema.String),
	operations: Schema.Array(DreamMutation),
});
export type DreamConsolidationPlan = typeof DreamConsolidationPlan.Type;

export interface DreamSubagentRequest {
	readonly cwd: string;
	readonly mode: DreamRunMode;
	readonly model: {
		readonly model: string;
		readonly thinking: "low" | "medium" | "high" | "xhigh";
		readonly maxTurns: number;
	};
	readonly memorySnapshot: MemoryEntriesSnapshot;
	readonly transcriptCandidates: ReadonlyArray<DreamTranscriptCandidate>;
	readonly nowIso: string;
}

export interface DreamRunResult {
	readonly mode: DreamRunMode;
	readonly startedAt: number;
	readonly finishedAt: number;
	readonly reviewedSessions: ReadonlyArray<DreamTranscriptCandidate>;
	readonly plan: DreamConsolidationPlan;
	readonly applied: ReadonlyArray<MutationResult>;
}
