# ADR: unify ralph and autoresearch on one loop engine

- Status: accepted
- Date: 2026-04-12
- Owners: tau
- Source inputs:
  - gpt-5.4-pro redesign brief and response packaged in `.codex/gpt54-pro-autoresearch-ralph-redesign-package.md`
  - oracle follow-up review and precision pass in this implementation session

## Context

Tau currently has two different long-running execution models.

- **Ralph** is command-owned, task-scoped, fresh-session oriented, and stored under `.pi/ralph/**`.
- **Autoresearch** is session-global, cwd-global, root-file driven, and reconstructed from `autoresearch.jsonl` plus `.autoresearch/**`.

That split creates the wrong architecture.

- lifecycle logic is duplicated
- persistence models do not match
- autoresearch depends on special root files and same-session auto-resume
- git cleanup behavior is too broad for a shared multi-agent repo

The repository explicitly prefers one canonical design, no fallback layers, no runtime compatibility shims, and invalid states that fail fast.

## Decision

Tau will replace the current parallel Ralph and autoresearch architectures with **one shared loop engine** plus **two workflow specializations**.

- **Ralph** becomes a specialization over the shared engine.
- **Autoresearch** becomes a task-scoped specialization over the same engine.
- The current cwd-global autoresearch design is removed.
- The current `.pi/ralph/**` runtime layout is removed.
- Unified loop runtime data lives under `.pi/loops/**`.

This ADR defines the architectural contract for that redesign.

## Why this decision

This design keeps one lifecycle model for long-running work.

- controller-owned start and resume
- fresh child sessions per iteration
- explicit completion handoff
- task-local notes and state
- pinned execution profile capture and reuse

Autoresearch still keeps its benchmark-specific behavior.

- benchmark command and checks
- metrics and confidence
- run artifacts
- keep and discard decisions
- trial-scoped VCS handling

## Decision details

### 1. Shared engine and workflow ownership

The shared loop engine owns:

- task lifecycle: create, start, resume, pause, stop, status, archive, cancel, clean
- controller and child session orchestration
- explicit iteration finalization
- task discovery and persistence
- archive handling
- pinned execution profile capture and apply
- status and widget integration

Workflow specializations own only their domain behavior.

| Workflow | Owns |
| --- | --- |
| `ralph` | checklist pacing, reflection cadence, completion semantics, generic task execution |
| `autoresearch` | phase contracts, trial execution, result capture, reflection-generated research directions, VCS trial decisions |

There is no separate top-level Ralph engine and no separate top-level autoresearch engine after this redesign.

### 2. Canonical storage root

`.pi/loops` is the only canonical runtime root for unified loop data.

The canonical layout is:

- `.pi/loops/tasks/<task-id>.md`
- `.pi/loops/state/<task-id>.json`
- `.pi/loops/phases/<task-id>/<phase-id>.json`
- `.pi/loops/runs/<task-id>/<run-id>/...`
- `.pi/loops/archive/tasks/<task-id>.md`
- `.pi/loops/archive/state/<task-id>.json`
- `.pi/loops/archive/phases/<task-id>/<phase-id>.json`
- `.pi/loops/archive/runs/<task-id>/<run-id>/...`

Tau may store additional loop-owned runtime metadata under `.pi/loops/**` when needed. That metadata remains machine-managed.

Each autoresearch phase also has an explicit machine-owned snapshot artifact. Phase snapshots live under `.pi/loops/phases/**` so phase identity, pinned execution profile, and blocked-phase debugging remain inspectable after later task edits.

The following layouts are not runtime storage after this redesign:

- `.pi/ralph/**`
- `.autoresearch/**`
- `autoresearch.jsonl`
- `autoresearch.md`
- `autoresearch.ideas.md`
- `autoresearch.program.md`
- `autoresearch.sh`
- `autoresearch.checks.sh`
- `autoresearch.config.json`

### 3. Path protection

Workspace protection keeps `.pi/**` protected by default.

This redesign introduces a narrow human-editable exception for `.pi/loops/tasks/**`. It does not make `.pi` or `.pi/loops` generally writable.

These paths are runtime-owned and machine-managed:

- `.pi/loops/state/**`
- `.pi/loops/runs/**`
- `.pi/loops/archive/**`
- isolated autoresearch checkout metadata and other loop-owned runtime data

General agent file editing and ad hoc shell workflows do not treat runtime-owned loop paths as normal working files.

### 4. Persisted model

Each task has exactly one canonical state document at `.pi/loops/state/<task-id>.json`.

That state is a strict tagged union with:

- shared loop fields
- `kind: "ralph"` specialization state
- `kind: "autoresearch"` specialization state

The shared union also includes an explicit blocked/manual-resolution shape with a reason code, operator-facing recovery message, and enough metadata to resume or abandon the task safely after intervention.

Tau does not use separate runtime models such as Ralph state files on one side and autoresearch JSONL replay on the other.

### 5. Task file contract

Every loop task is a canonical task document at `.pi/loops/tasks/<task-id>.md`.

Each task file begins with mandatory frontmatter that includes at least:

- `kind`
- `title`

For `kind: autoresearch`, frontmatter defines the user-authored experiment contract.

`scope.root` is the phase execution root. Tau does not support a separate hidden working-directory config for autoresearch.

Required contract fields:

- `kind`
- `title`
- `benchmark.command`
- `metric.name`
- `metric.unit`
- `metric.direction`
- `scope.root`
- `scope.paths`
- `scope.off_limits`
- `constraints`

Optional contract fields:

- `benchmark.checks_command`
- `limits.max_iterations`

The markdown body replaces `autoresearch.md`, `autoresearch.ideas.md`, and `autoresearch.program.md`.

The body holds:

- human-readable goal
- program and approach notes
- ideas and deferred directions
- findings
- progress
- next steps

The task document uses stable machine-owned anchors.

- frontmatter is schema-owned
- workflow-managed sections use stable headings and stable structural meaning
- prose inside those sections remains human-editable unless a section is explicitly runtime-owned

Implementations do not guess where to rewrite structured progress, reflection output, findings, or next steps.

### 6. Phase model for autoresearch

Autoresearch uses immutable phases.

Each phase snapshot contains:

- benchmark command
- optional checks command
- primary metric name, unit, and direction
- execution root
- scope paths
- off-limits paths
- constraints
- execution profile captured and pinned at phase start

Results are comparable only within the same phase.

Changing a phase-defining contract field makes the current phase non-resumable and requires starting a new phase.

Phase-defining identity is computed from a normalized projection of:

- `benchmark.command`
- `benchmark.checks_command`
- `metric.name`
- `metric.unit`
- `metric.direction`
- `scope.root`
- normalized `scope.paths`
- normalized `scope.off_limits`
- normalized `constraints`
- pinned execution profile captured at phase start

Phase identity does not include:

- `title`
- `limits.max_iterations`
- any markdown body content
- ideas, findings, notes, progress, or program text
- machine-managed counters, timestamps, result history, or archive metadata

Markdown body edits are non-phase-defining and never invalidate a phase.

`scope.paths` and `scope.off_limits` are normalized relative to `scope.root`, persisted in normalized form, and rejected if normalization would escape `scope.root`.

### 7. Session and iteration lifecycle

The loop engine uses Ralph-style controller ownership.

- the command layer owns session creation and switching
- each active task has one controller session
- each active task has at most one active child session

Persisted state stores both the opaque session id and the session file path for controller and child sessions. Session ids drive live runtime ownership. Session file paths support recovery, UI navigation, and restart-time reconciliation.

Each child session represents one iteration.

For autoresearch, one iteration equals one trial.

That child session may:

- inspect and update the task file
- edit code in the task's working checkout
- execute one benchmark trial
- finalize that trial

Tools and event handlers do not create or switch sessions.

Same-session autoresearch continuation by injecting follow-up user messages is removed.

### 8. Command surface

User-facing commands remain workflow-specific.

This ADR keeps:

- `/ralph ...`
- `/autoresearch ...`

This ADR does not add a user-facing generic `/loops` command.

The supported autoresearch command surface is:

- `/autoresearch create`
- `/autoresearch start`
- `/autoresearch resume`
- `/autoresearch pause`
- `/autoresearch stop`
- `/autoresearch status`
- `/autoresearch archive`
- `/autoresearch cancel`
- `/autoresearch clean`

Autoresearch is task-scoped. It is not a cwd-global or session-global mode.

The current mode-oriented `/autoresearch [off|clear|<text>]` interface is removed.

### 9. Tool surface

The redesign removes:

- `init_experiment`
- `run_experiment`
- `log_experiment`

They are removed, not deprecated, aliased, or retained as compatibility tools.

The only autoresearch loop tools are:

- `autoresearch_run`
- `autoresearch_done`

`autoresearch_run` semantics:

- executes exactly one trial against the active phase snapshot
- records one pending trial with logs, parsed metrics, checks output, artifacts, and execution metadata
- is valid only inside the active controller-owned autoresearch child session for the matching task

`autoresearch_done` semantics:

- is the only way to resolve the pending trial
- records the trial decision and structured result
- performs the matching task-scoped VCS action
- is valid only inside the active controller-owned autoresearch child session for the matching task

Valid autoresearch outcomes are:

- `keep`
- `discard`
- `crash`
- `checks_failed`

Invariants:

- each autoresearch task has at most one pending trial at a time
- a second `autoresearch_run` before `autoresearch_done` is invalid
- calling autoresearch tools from the controller session, from unrelated sessions, or with no active autoresearch task is invalid and fails fast

Unsafe VCS cleanup is not a normal trial outcome. If tau cannot safely resolve the isolated checkout for a non-keep result, `autoresearch_done` fails fast, preserves the task for operator intervention, and does not record a synthetic fallback outcome.

Kept changes remain on the task's isolated branch and checkout until an explicit later integration step. `keep` does not implicitly propagate accepted changes into the user's primary workspace checkout.

### 10. Reflection and notes

Ralph keeps generic reflection behavior.

Autoresearch uses the same lifecycle hook but with benchmark-specific reflection content.

Autoresearch reflection must:

- summarize what was tried
- record what happened
- record the trial outcome and its implications for the next direction
- summarize the current best result for the phase from machine-managed state
- synthesize next research directions
- prune dead directions

Ideas remain inside the task markdown body. They are not stored in a separate autoresearch sidecar file.

### 11. VCS isolation model

Autoresearch trials run in a controller-owned, task-scoped isolated VCS checkout.

That isolated checkout is:

- unique per task
- separate from the user's primary workspace checkout
- never shared across tasks

The canonical loop state records:

- the resolved isolated checkout path
- the task branch
- the phase base commit

The physical path of the isolated checkout is not part of the architectural contract.

Implementations should prefer a tau-owned task-local location associated with `.pi/loops` when that integrates cleanly with workspace protection. This ADR does not require a specific filesystem location.

VCS behavior:

- `keep` commits are recorded in the isolated checkout
- non-keep outcomes reset only the isolated checkout
- the user’s primary workspace is not cleaned, reset, or destructively restored to implement autoresearch cleanup

Tau never uses destructive restore, clean, or reset operations in the user’s primary workspace to implement autoresearch trial cleanup.

If VCS resolution is ambiguous, overlaps unrelated changes, or cannot safely restore the isolated checkout, the task remains blocked for manual operator resolution instead of inventing a fallback trial result.

### 12. Legacy handling

Legacy Ralph and autoresearch layouts are not read by the steady-state runtime.

If migration support exists, it is an explicit one-shot importer that writes canonical `.pi/loops` data.

There is no:

- dual-read runtime
- fallback storage lookup
- compatibility alias layer
- automatic long-term import path embedded in runtime behavior

## Explicit invariants

These statements are architectural invariants.

1. `.pi/loops` is the only canonical runtime root for unified loop data.
2. Every task has exactly one specialization kind: `ralph` or `autoresearch`.
3. Loop-owned task files live only under `.pi/loops/tasks/**`.
4. Autoresearch is task-scoped, not cwd-global and not session-global.
5. Autoresearch phases are immutable snapshots.
6. Notes and progress are non-phase-defining.
7. Each active task has one controller session and at most one active child session.
8. Each autoresearch child session executes at most one trial before finalization.
9. Each autoresearch task has at most one pending trial at a time.
10. Special filenames such as `autoresearch.sh` and `autoresearch.checks.sh` are not part of protocol. If a task uses scripts, they are ordinary repo files referenced by the task contract.
11. Legacy layouts are import-only or fail-fast. They are never part of steady-state runtime behavior.

## Non-goals

This ADR does not do the following.

1. It does not preserve a runtime compatibility layer between old and new layouts.
2. It does not introduce a user-facing generic `/loops` command.
3. It does not keep singleton autoresearch mode attached to the active session.
4. It does not preserve cwd-global autoresearch sidecar files.
5. It does not allow arbitrary external task-file locations as canonical storage.
6. It does not keep multi-trial same-session autoresearch looping.
7. It does not allow mixed phase semantics where some contract changes mutate in place and others silently start a new phase.

## Alternatives rejected

| Alternative | Why rejected |
| --- | --- |
| Keep current autoresearch and only borrow Ralph ideas | Leaves duplicated lifecycle, global state, and same-session continuation in place |
| Make autoresearch a thin veneer over current Ralph without a shared core | Forces benchmark-specific state into the wrong abstraction or duplicates a second engine beside Ralph |
| Preserve `.pi/ralph/**` and cwd-global autoresearch files as parallel runtime layouts | Violates canonical architecture goals and invites long-term compatibility drift |
| Keep `init_experiment`, `run_experiment`, and `log_experiment` as aliases | Recreates the old lifecycle under new names and undermines the controller-owned iteration model |
| Continue destructive cleanup in the user’s primary checkout | Unsafe in a shared multi-agent repo and inconsistent with task-scoped VCS isolation |

## Consequences

### Positive

- one lifecycle model for long-running work
- clearer task ownership
- consistent fresh-context boundaries
- task-local notes and state
- cleaner benchmark phase model
- safer autoresearch git behavior
- less architectural duplication

### Costs

- this is a breaking redesign
- path-policy rules must be updated for `.pi/loops/tasks/**`
- both Ralph and autoresearch storage code will change substantially
- an optional importer must stay explicit and separate from runtime behavior

### Operational consequences

- results from different phases are intentionally separated
- note edits no longer disturb run comparability
- benchmarks no longer depend on special filenames
- controller-owned orchestration becomes the only valid continuation model

## Implementation plan

Implement in this order.

1. Introduce the shared loop engine and shared task repo.
2. Introduce `.pi/loops/**` as the canonical runtime root.
3. Port Ralph onto the shared engine while keeping `/ralph` as the user-facing surface.
4. Implement autoresearch as a new specialization on the shared engine.
5. Replace autoresearch root files with task-local markdown and state.
6. Replace the current autoresearch tool trio with `autoresearch_run` and `autoresearch_done`.
7. Introduce task-scoped isolated VCS checkout orchestration.
8. Add an explicit importer only if legacy data must be preserved.
9. Delete the old Ralph and autoresearch runtime implementations.

## Review points for follow-up design and implementation

The next design reviews should focus on:

1. the shared loop state machine and service boundaries
2. path policy and task-repo ownership under `.pi/loops/**`
3. autoresearch phase schema and fingerprint normalization
4. isolated checkout orchestration and failure semantics
5. command UX and child-session ownership rules

This ADR is the foundation. Later implementation docs should refine APIs and state schemas without changing these architectural decisions.
