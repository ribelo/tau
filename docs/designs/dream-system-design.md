# Dream System Design for tau

**Source:** GPT-5.4-Pro architectural design  
**Date:** 2025-04-02

---

## Overview

This document contains the complete design for porting the `/dream` behavior from claude-code into tau as a native Effect-TS v4 subsystem.

**Core principle:** The subagent proposes; DreamRunner applies.

---

## Architecture

The dream subsystem is split into these services:

* `DreamRunner`: one orchestration entrypoint for manual and auto runs
* `DreamScheduler`: auto gates + durable "last successful run" state
* `DreamLock`: per-workspace lock lease
* `DreamTaskRegistry`: UI-visible task state + cancellation
* `DreamSubagent`: forked agent that **reads** transcripts and current memory snapshot, then returns a **structured consolidation plan**
* `CuratedMemory`: unchanged; DreamRunner applies the returned plan via `add/update/remove`, then calls `reloadFrozenSnapshot`

The biggest design choice is this: **the subagent should not write memory directly**. It should return a typed plan, and DreamRunner should apply it. That keeps all dedupe, size-limit, id, and reload behavior inside tau's existing memory service, which is already where those invariants live.

---

## Settings Shape

Placed under `tau.dream`:

```json
{
  "tau": {
    "dream": {
      "enabled": true,
      "manual": {
        "enabled": true
      },
      "auto": {
        "enabled": false,
        "minHoursSinceLastRun": 24,
        "minSessionsSinceLastRun": 5,
        "scanThrottleMinutes": 10
      },
      "subagent": {
        "model": "openai-codex/gpt-5.4",
        "thinking": "high",
        "maxTurns": 8
      }
    }
  }
}
```

Configuration policy:
- Dream requires an explicit `tau.dream` block.
- Dream applies no implicit defaults for enablement, model, thinking, or thresholds.
- Partial configuration fails fast with a decode/config error.

---

## Contracts

### 1) Configuration Contracts

```ts
// dream/config.ts
import { Effect, Schema } from "effect"

export const DreamThinking = Schema.Literal("low", "medium", "high", "xhigh")
export type DreamThinking = typeof DreamThinking.Type

export const DreamModelConfigInput = Schema.Struct({
  model: Schema.optional(Schema.String),
  thinking: Schema.optional(DreamThinking),
  maxTurns: Schema.optional(Schema.Number),
})
export type DreamModelConfigInput = typeof DreamModelConfigInput.Type

export const ManualDreamConfigInput = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
})
export type ManualDreamConfigInput = typeof ManualDreamConfigInput.Type

export const AutoDreamConfigInput = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  minHoursSinceLastRun: Schema.optional(Schema.Number),
  minSessionsSinceLastRun: Schema.optional(Schema.Number),
  scanThrottleMinutes: Schema.optional(Schema.Number),
})
export type AutoDreamConfigInput = typeof AutoDreamConfigInput.Type

export const DreamConfigInput = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  manual: Schema.optional(ManualDreamConfigInput),
  auto: Schema.optional(AutoDreamConfigInput),
  subagent: Schema.optional(DreamModelConfigInput),
})
export type DreamConfigInput = typeof DreamConfigInput.Type

export const TauSettingsWithDreamInput = Schema.Struct({
  tau: Schema.Struct({
    dream: Schema.optional(DreamConfigInput),
  }),
})
export type TauSettingsWithDreamInput = typeof TauSettingsWithDreamInput.Type

export interface DreamModelConfig {
  readonly model: string
  readonly thinking: DreamThinking
  readonly maxTurns: number
}

export interface AutoDreamConfig {
  readonly enabled: boolean
  readonly minHoursSinceLastRun: number
  readonly minSessionsSinceLastRun: number
  readonly scanThrottleMinutes: number
}

export interface DreamConfig {
  readonly enabled: boolean
  readonly manual: {
    readonly enabled: boolean
  }
  readonly auto: AutoDreamConfig
  readonly subagent: DreamModelConfig
}

export interface DreamConfigLoader {
  readonly load: (settingsJson: unknown) => Effect.Effect<DreamConfig, DreamConfigError>
}
```

**Resolution rules:**
1. Decode merged `settings.tau.dream` (user + project) with `DreamConfigInput`
2. Validate thresholds (`>= 0`) and `subagent.maxTurns` (positive integer)
3. Fail fast on any missing or invalid field

That keeps dream on a **specific, explicitly configured** model/thinking pair and never on the ambient session model.

---

### 2) Domain Contracts

```ts
// dream/domain.ts
import { Schema } from "effect"
import type { MemoryEntriesSnapshot, MutationResult } from "../services/curated-memory.js"
import { MemoryEntryId } from "../memory/format.js"

export const DreamRunMode = Schema.Literal("manual", "auto")
export type DreamRunMode = typeof DreamRunMode.Type

export const DreamPhase = Schema.Literal(
  "queued",
  "orient",
  "gather",
  "consolidate",
  "prune",
  "apply",
  "done",
)
export type DreamPhase = typeof DreamPhase.Type

export const DreamTaskStatus = Schema.Literal(
  "running",
  "completed",
  "failed",
  "cancelled",
)
export type DreamTaskStatus = typeof DreamTaskStatus.Type

export const DreamMemoryScope = Schema.Literal("project", "global", "user")
export type DreamMemoryScope = typeof DreamMemoryScope.Type

export const DreamTaskId = Schema.String
export type DreamTaskId = typeof DreamTaskId.Type

export interface DreamTranscriptCandidate {
  readonly sessionId: string
  readonly path: string
  readonly touchedAt: number
}

export interface DreamAutoPermit {
  readonly sinceMs: number
  readonly sessions: ReadonlyArray<DreamTranscriptCandidate>
}

export interface DreamRunRequest {
  readonly cwd: string
  readonly mode: DreamRunMode
  readonly currentSessionId?: string
  readonly requestedBy: "user" | "scheduler"
}

export interface DreamTaskHandle {
  readonly taskId: DreamTaskId
}

export type DreamProgressEvent =
  | {
      readonly _tag: "PhaseChanged"
      readonly phase: DreamPhase
      readonly message?: string
    }
  | {
      readonly _tag: "SessionsDiscovered"
      readonly total: number
    }
  | {
      readonly _tag: "SessionsReviewed"
      readonly reviewed: number
      readonly total: number
    }
  | {
      readonly _tag: "OperationsPlanned"
      readonly total: number
    }
  | {
      readonly _tag: "OperationApplied"
      readonly applied: number
      readonly total: number
      readonly summary: string
    }
  | {
      readonly _tag: "Note"
      readonly text: string
    }

export interface DreamTaskState {
  readonly id: DreamTaskId
  readonly type: "dream"
  readonly mode: DreamRunMode
  readonly status: DreamTaskStatus
  readonly phase: DreamPhase
  readonly startedAt: number
  readonly finishedAt?: number
  readonly sessionsDiscovered: number
  readonly sessionsReviewed: number
  readonly operationsPlanned: number
  readonly operationsApplied: number
  readonly latestMessage?: string
  readonly cancellable: boolean
}

export const DreamAddOperation = Schema.Struct({
  _tag: Schema.Literal("add"),
  scope: DreamMemoryScope,
  content: Schema.String,
  rationale: Schema.String,
})

export const DreamUpdateOperation = Schema.Struct({
  _tag: Schema.Literal("update"),
  scope: DreamMemoryScope,
  id: MemoryEntryId,
  content: Schema.String,
  rationale: Schema.String,
})

export const DreamRemoveOperation = Schema.Struct({
  _tag: Schema.Literal("remove"),
  scope: DreamMemoryScope,
  id: MemoryEntryId,
  rationale: Schema.String,
})

export const DreamMutation = Schema.Union(
  DreamAddOperation,
  DreamUpdateOperation,
  DreamRemoveOperation,
)
export type DreamMutation = typeof DreamMutation.Type

export const DreamConsolidationPlan = Schema.Struct({
  summary: Schema.String,
  reviewedSessions: Schema.Array(Schema.String),
  pruneNotes: Schema.Array(Schema.String),
  operations: Schema.Array(DreamMutation),
})
export type DreamConsolidationPlan = typeof DreamConsolidationPlan.Type

export interface DreamSubagentRequest {
  readonly cwd: string
  readonly mode: DreamRunMode
  readonly model: {
    readonly model: string
    readonly thinking: "low" | "medium" | "high" | "xhigh"
    readonly maxTurns: number
  }
  readonly memorySnapshot: MemoryEntriesSnapshot
  readonly transcriptCandidates: ReadonlyArray<DreamTranscriptCandidate>
  readonly nowIso: string
}

export interface DreamRunResult {
  readonly mode: DreamRunMode
  readonly startedAt: number
  readonly finishedAt: number
  readonly reviewedSessions: ReadonlyArray<DreamTranscriptCandidate>
  readonly plan: DreamConsolidationPlan
  readonly applied: ReadonlyArray<MutationResult>
}
```

The key contract here is `DreamConsolidationPlan`: the forked agent returns a typed patch, and **DreamRunner** becomes the only writer.

---

### 3) Error Contracts

```ts
// dream/errors.ts
import { Schema } from "effect"

export class DreamLockHeld extends Schema.TaggedErrorClass<DreamLockHeld>()(
  "DreamLockHeld",
  {
    path: Schema.String,
    holderPid: Schema.optional(Schema.Number),
  },
) {}

export class DreamLockCorrupt extends Schema.TaggedErrorClass<DreamLockCorrupt>()(
  "DreamLockCorrupt",
  {
    path: Schema.String,
    reason: Schema.String,
  },
) {}

export class DreamLockIoError extends Schema.TaggedErrorClass<DreamLockIoError>()(
  "DreamLockIoError",
  {
    path: Schema.String,
    operation: Schema.String,
    reason: Schema.String,
  },
) {}

export type DreamLockError =
  | DreamLockHeld
  | DreamLockCorrupt
  | DreamLockIoError

export class DreamDisabled extends Schema.TaggedErrorClass<DreamDisabled>()(
  "DreamDisabled",
  {
    mode: Schema.Literal("manual", "auto"),
  },
) {}

export class DreamTooSoon extends Schema.TaggedErrorClass<DreamTooSoon>()(
  "DreamTooSoon",
  {
    lastCompletedAtMs: Schema.Number,
    hoursSinceLastRun: Schema.Number,
    minHoursSinceLastRun: Schema.Number,
  },
) {}

export class DreamNotEnoughSessions extends Schema.TaggedErrorClass<DreamNotEnoughSessions>()(
  "DreamNotEnoughSessions",
  {
    found: Schema.Number,
    required: Schema.Number,
  },
) {}

export class DreamSessionScanThrottled extends Schema.TaggedErrorClass<DreamSessionScanThrottled>()(
  "DreamSessionScanThrottled",
  {
    lastScanAtMs: Schema.Number,
    scanThrottleMinutes: Schema.Number,
  },
) {}

export type DreamGateError =
  | DreamDisabled
  | DreamTooSoon
  | DreamNotEnoughSessions
  | DreamSessionScanThrottled

export class DreamSubagentSpawnFailed extends Schema.TaggedErrorClass<DreamSubagentSpawnFailed>()(
  "DreamSubagentSpawnFailed",
  {
    reason: Schema.String,
  },
) {}

export class DreamSubagentAborted extends Schema.TaggedErrorClass<DreamSubagentAborted>()(
  "DreamSubagentAborted",
  {},
) {}

export class DreamSubagentInvalidPlan extends Schema.TaggedErrorClass<DreamSubagentInvalidPlan>()(
  "DreamSubagentInvalidPlan",
  {
    reason: Schema.String,
  },
) {}

export type DreamSubagentError =
  | DreamSubagentSpawnFailed
  | DreamSubagentAborted
  | DreamSubagentInvalidPlan

export class DreamConfigDecodeError extends Schema.TaggedErrorClass<DreamConfigDecodeError>()(
  "DreamConfigDecodeError",
  {
    reason: Schema.String,
  },
) {}

export class DreamConfigMissingModel extends Schema.TaggedErrorClass<DreamConfigMissingModel>()(
  "DreamConfigMissingModel",
  {
    path: Schema.String,
  },
) {}

export class DreamConfigInvalidThreshold extends Schema.TaggedErrorClass<DreamConfigInvalidThreshold>()(
  "DreamConfigInvalidThreshold",
  {
    field: Schema.String,
    value: Schema.Number,
  },
) {}

export type DreamConfigError =
  | DreamConfigDecodeError
  | DreamConfigMissingModel
  | DreamConfigInvalidThreshold
```

Gate failures are kept separate from lock failures. "Too soon" and "not enough sessions" are expected policy outcomes; "lock held" is a concurrency condition.

---

### 4) Service Interfaces

```ts
// dream/services.ts
import { Effect, Option, Scope, Stream, Fiber } from "effect"
import type {
  DreamAutoPermit,
  DreamConsolidationPlan,
  DreamProgressEvent,
  DreamRunRequest,
  DreamRunResult,
  DreamSubagentRequest,
  DreamTaskHandle,
  DreamTaskId,
  DreamTaskState,
} from "./domain.js"
import type {
  DreamConfigError,
  DreamGateError,
  DreamLockError,
  DreamSubagentError,
} from "./errors.js"
import type {
  MemoryFileError,
  MemoryMutationError,
} from "../memory/errors.js"

export type DreamRunError =
  | DreamConfigError
  | DreamGateError
  | DreamLockError
  | DreamSubagentError
  | MemoryMutationError
  | MemoryFileError

export interface DreamLease {
  readonly path: string
  readonly acquiredAtMs: number
}

export interface DreamLockApi {
  readonly acquire: (
    cwd: string,
  ) => Effect.Effect<DreamLease, DreamLockError, Scope.Scope>

  readonly inspect: (
    cwd: string,
  ) => Effect.Effect<
    Option.Option<{
      readonly path: string
      readonly holderPid?: number
      readonly acquiredAtMs?: number
    }>,
    DreamLockError
  >
}

export interface DreamSchedulerApi {
  readonly evaluateAutoStart: (
    request: DreamRunRequest,
  ) => Effect.Effect<DreamAutoPermit, DreamConfigError | DreamGateError | DreamLockError>

  readonly markCompleted: (
    cwd: string,
    result: DreamRunResult,
  ) => Effect.Effect<void, DreamLockError>

  readonly readLastCompletedAt: (
    cwd: string,
  ) => Effect.Effect<number | null, DreamLockError>
}

export interface DreamTaskRegistryApi {
  readonly create: (
    request: DreamRunRequest,
  ) => Effect.Effect<DreamTaskHandle>

  readonly attach: (
    taskId: DreamTaskId,
    fiber: Fiber.RuntimeFiber<DreamRunResult, DreamRunError>,
  ) => Effect.Effect<void>

  readonly report: (
    taskId: DreamTaskId,
    event: DreamProgressEvent,
  ) => Effect.Effect<void>

  readonly complete: (
    taskId: DreamTaskId,
    result: DreamRunResult,
  ) => Effect.Effect<void>

  readonly fail: (
    taskId: DreamTaskId,
    cause: DreamRunError,
  ) => Effect.Effect<void>

  readonly cancel: (
    taskId: DreamTaskId,
  ) => Effect.Effect<void>

  readonly get: (
    taskId: DreamTaskId,
  ) => Effect.Effect<DreamTaskState>

  readonly watch: (
    taskId: DreamTaskId,
  ) => Stream.Stream<DreamTaskState>
}

export interface DreamSubagentApi {
  readonly plan: (
    request: DreamSubagentRequest,
    onEvent: (event: DreamProgressEvent) => Effect.Effect<void>,
  ) => Effect.Effect<DreamConsolidationPlan, DreamSubagentError>
}

export interface DreamRunnerApi {
  readonly runOnce: (
    request: DreamRunRequest,
  ) => Effect.Effect<DreamRunResult, DreamRunError>

  readonly spawnManual: (
    request: DreamRunRequest,
  ) => Effect.Effect<DreamTaskHandle, DreamConfigError | DreamGateError | DreamLockError>

  readonly maybeSpawnAuto: (
    request: DreamRunRequest,
  ) => Effect.Effect<Option.Option<DreamTaskHandle>, DreamConfigError | DreamLockError>
}
```

---

### 5) Service-Tag Pattern

For the live services, use the official app-service pattern:

```ts
// shape only, not implementation
class DreamRunner extends Effect.Service()("tau/DreamRunner", {
  accessors: true,
  effect: /* omitted */,
  dependencies: [
    DreamScheduler.Default,
    DreamLock.Default,
    DreamTaskRegistry.Default,
    DreamSubagent.Default,
    CuratedMemoryLive,
  ],
}) {}
```

That matches the current Effect docs: `Effect.Service()` for app services with generated `.Default` layers.

---

## How the Runner Should Work

### Manual `/dream`

`/dream` should:

1. Validate config: `dream.enabled && dream.manual.enabled`
2. Create task immediately in `DreamTaskRegistry`
3. Fork `DreamRunner.runOnce(...)` in a background fiber
4. Attach fiber to task registry
5. Return task id immediately to the command handler

Cancellation calls `DreamTaskRegistry.cancel(taskId)`, which interrupts the fiber. Because the lock is acquired as a scoped resource, interruption releases it automatically.

### Auto-dream

`DreamScheduler.evaluateAutoStart` should:

1. Validate `dream.enabled && dream.auto.enabled`
2. Read last successful completion time from durable state
3. Enforce `minHoursSinceLastRun`
4. Enforce `scanThrottleMinutes` using a service-local `Ref<number | null>`
5. Scan project transcript storage for sessions touched since last success
6. Exclude the current session
7. Enforce `minSessionsSinceLastRun`
8. Fail if a dream lock is already held
9. Return `DreamAutoPermit`

### DreamRunner Integration with CuratedMemory

`DreamRunner.runOnce` should be conceptually:

1. acquire `DreamLock`
2. report `orient`
3. load `CuratedMemory.getEntriesSnapshot(cwd)`
4. discover transcript candidates from scheduler / transcript scan
5. call `DreamSubagent.plan(...)`
6. report `apply`
7. apply each planned operation through:
   * `CuratedMemory.add(scope, content, cwd)`
   * `CuratedMemory.update(scope, id, content, cwd)`
   * `CuratedMemory.remove(scope, id, cwd)`
8. call `CuratedMemory.reloadFrozenSnapshot(cwd)`
9. report completion
10. mark scheduler success

That uses tau's memory service exactly where it is strongest today: scope-aware files, duplicate/no-match/size-limit errors, and frozen prompt refresh for future sessions.

**Design nuance:** For **auto** dream, treat `MemoryDuplicateEntry` and `MemoryNoMatch` as soft apply conflicts and continue, because auto runs can race with ordinary memory writes. For **manual** dream, surface them in the task UI as skipped/conflicted operations rather than hard-failing the whole run.

---

## How the Subagent Should Work

The subagent contract should be:

* exact `model` and `thinking` from `tau.dream.subagent`
* no inheritance from the active session model
* read-only transcript access
* **no memory write tools**
* output must validate as `DreamConsolidationPlan`

Its prompt should preserve the 4 Claude phases conceptually:

* **Orient**: inspect the current memory snapshot you pass in
* **Gather**: search/read recent transcript candidates
* **Consolidate**: propose add/update/remove ops
* **Prune**: prefer merges/removals when entries are stale, duplicate, or oversized

---

## UI Progress Model

The task card should show:

* mode: manual / auto
* phase: orient / gather / consolidate / prune / apply
* sessions found
* sessions reviewed
* operations planned
* operations applied
* latest note
* cancel button while running

That mirrors Claude's "visible dream task with cancellation", but with a more meaningful task model for structured memory operations.

---

## Command Registration and Startup Wiring

* `/dream` command handler:
  * call `DreamRunner.spawnManual({ cwd, mode: "manual", requestedBy: "user", currentSessionId })`
  * notify the user with the task id or just surface the task in the existing task list
* startup/init layer:
  * register a lightweight hook that calls `DreamRunner.maybeSpawnAuto({ cwd, mode: "auto", requestedBy: "scheduler", currentSessionId })`
  * best trigger points are startup plus post-turn / session-close / session-switch
  * swallow `None`; log gate closures at debug level only

---

## Summary

The single most important architectural rule:

**Subagent proposes; DreamRunner applies.**

That single choice gives you:

* exact model/thinking overrides
* typed/validated output
* centralized memory invariants
* safer cancellation
* cleaner progress accounting
* much simpler testing

It is the difference between "ported feature" and "native tau subsystem."
