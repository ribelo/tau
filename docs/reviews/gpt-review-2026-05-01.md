# Deep architecture and correctness review

I treated the Repomix package as the primary source for this pass and did not inspect the repository outside the packaged content. The package is sufficient for the requested Ralph/shared-loop review, with one limitation: a few imported support services are referenced but not fully present in the snippets surfaced here, so findings involving those boundaries are based on visible call sites and contracts rather than full implementation internals.  

The most important conclusion: **the shared loop engine direction is right, but the current implementation is not yet a single coherent ownership/control system.** There are still three overlapping control planes: LoopEngine ownership, Ralph’s legacy adapter/current-loop state, and UI/tool activation transforms. Autoresearch also partially uses the shared engine while still doing direct state mutation and destructive workspace finalization. That combination creates real correctness bugs, not just architectural rough edges.

---

## Confirmed correctness risks

### P0 — Autoresearch can enter an unrecoverable pending-run state when child ownership is cleared

**Affected files:** `extensions/tau/src/autoresearch/index.ts`, `extensions/tau/src/services/loop-engine.ts`, `extensions/tau/src/services/autoresearch-loop-runner.ts`, `extensions/tau/src/loops/schema.ts`.

**Why it matters:** The ADR says each autoresearch child session equals one trial, `autoresearch_run` is valid only inside the active child session, and `autoresearch_done` is the required way to resolve a pending trial. It also says each task has at most one pending trial. 

**Failure mode:** The visible command/tool layer requires an active child context to run or finish a trial, and it rejects creating a new child when `pendingRunId` is present. It also rejects `/autoresearch pause` and `/autoresearch stop` while a pending run exists.  Separately, LoopEngine’s `pauseLoop`, `stopLoop`, and `clearChildSession` clear `ownership.child` without any autoresearch-specific pending-run invariant.  That creates a stuck shape: `pendingRunId = Some(...)` and `ownership.child = None`. In that shape, `autoresearch_done` cannot run because there is no active child, but a new child cannot be created because a run is pending.

**Best repair direction:** Encode the invariant in the shared loop state machine: for autoresearch, `pendingRunId` must imply a resolvable child owner or a `blocked_manual_resolution` state with recovery metadata. Move child shutdown handling and pending-run resolution into LoopEngine, not direct event handlers. Any child-loss while pending should transition to `blocked_manual_resolution`, not silently clear child ownership. Add a test for `pendingRunId + child shutdown` and a recovery path that can abandon or finalize a pending run explicitly.

---

### P0 — Autoresearch finalization still mutates the real workspace destructively, contradicting the accepted shared-loop design

**Affected files:** `extensions/tau/src/autoresearch/index.ts`, `extensions/tau/test/autoresearch-service.test.ts`, ADR.

**Why it matters:** The accepted ADR explicitly says `autoresearch_done` records the label and clears ownership while leaving the workspace exactly as the child session finalized it. It also says Tau must not use destructive restore, clean, or reset operations in the user’s primary workspace. 

**Failure mode:** The implementation auto-commits kept runs by running `git add -A`, `git commit`, and `git rev-parse`; for non-keep outcomes it runs `git checkout -- .` and `git clean -fd`. The tests assert this behavior as expected.  In a shared multi-agent checkout this can commit unrelated work or delete untracked files from other agents. It is a direct safety and data-loss risk.

**Best repair direction:** Remove workspace mutation from `autoresearch_done`. Make it a pure state/artifact finalizer: record outcome, parsed metrics, ASI, run logs, and clear pending/child ownership. If a cleanup/commit workflow is needed, expose it as a separate explicit command with clear scope, confirmation, and ideally diff-based/task-scoped safeguards. The existing tests that expect auto-commit/auto-revert should be replaced with tests enforcing the ADR behavior.

---

### P1 — Loop state is resolved from inconsistent roots, so the same checkout can have multiple invisible `.pi/loops` universes

**Affected files:** `extensions/tau/src/services/loop-engine.ts`, `extensions/tau/src/loops/repo.ts`, `extensions/tau/src/ralph/index.ts`, `extensions/tau/src/services/ralph.ts`, `extensions/tau/src/autoresearch/index.ts`, `extensions/tau/src/agents-menu/state.ts`, `extensions/tau/src/sandbox/workspace-root.ts`.

**Why it matters:** The ADR makes `.pi/loops` the only canonical runtime root.  But many loop calls pass raw `ctx.cwd` into LoopEngine and LoopRepo, while agent settings and Ralph-owned session cache resolve through `findNearestWorkspaceRoot(cwd)`. The agent menu explicitly builds settings and Ralph-state cache paths from `findNearestWorkspaceRoot(cwd)`.  LoopEngine and RalphContractResolver list states by the `cwd` they are given.

**Failure mode:** Starting `/ralph` or `/autoresearch` from a subdirectory can write loop state under `<subdir>/.pi/loops`, while the agent menu, Ralph-owned-session cache, and sandbox policy may read from the repository root. That means a session can be owned according to LoopEngine but not according to the UI/tool-policy layer, or vice versa. This is the exact “loop state resolved from the wrong workspace root” class of bug requested in the prompt.

**Best repair direction:** Introduce a single `LoopWorkspaceRoot` resolver and require all loop command/service/repo entrypoints to accept a normalized loop workspace root, not arbitrary `ctx.cwd`. Store the resolved root in loop state at creation time or derive it consistently from task file location. Tests should start loops from nested directories and verify that Ralph, Autoresearch, agents-menu, sandbox, and LoopEngine all read/write the same `.pi/loops`.

---

### P1 — Ralph’s `currentLoopRef` is process-global and can become stale across sessions/workspaces

**Affected files:** `extensions/tau/src/services/ralph.ts`, `extensions/tau/src/ralph/index.ts`.

**Why it matters:** Ralph’s ownership model is supposed to be session/file based through LoopEngine, but `RalphLive` still maintains a service-level current loop reference. `resolveLoopForUi` first tries `currentLoopRef`, then session ownership, then a sole-active fallback. `pauseCurrentLoop` also first trusts `currentLoopRef`; if the referenced state is missing, it returns `missing_current_loop_state` instead of falling back to active loop discovery.

**Failure mode:** In a multi-session or multi-workspace process, one terminal can set the current Ralph loop, then another terminal can call `/ralph pause` or `/ralph status` and resolve against the stale loop name. If that name is absent in the second `cwd`, pause returns a missing-current-state result even if there is a valid active loop. If the same loop name exists in another workspace, commands can target the wrong logical task.

**Best repair direction:** Delete `currentLoopRef` as an ownership source. UI resolution should be pure: resolve by current session ownership, then explicit command target, then a carefully scoped “single active loop in this workspace” fallback. If a cache is retained for UI convenience, key it by normalized loop root and session file, and clear it on every session switch/shutdown.

---

### P1 — Ralph’s tool/agent capability contract is not a single enforcement boundary

**Affected files:** `extensions/tau/src/ralph/contract.ts`, `extensions/tau/src/ralph/resolver.ts`, `extensions/tau/src/ralph/index.ts`, `extensions/tau/src/agents-menu/index.ts`, `extensions/tau/src/agent/control.ts`, `extensions/tau/src/agent/tool-allowlist.ts`.

**Why it matters:** The contract claims to be the source of truth for what tools and agents a Ralph loop may use, captured and reapplied to every owned session.  But active tool state is also modified by the agents-menu transform, and worker agents use their own allowlist/execution-policy path.

**Failure mode A — UI transform re-adds `agent`:** Ralph applies a contract by setting the session’s active tools.  The agents menu later installs a `setToolActivationTransform` that appends `agent` whenever at least one agent is enabled.  If Ralph’s contract removes the `agent` tool but the Ralph agent policy still enables `finder`, the transform can make `agent` visible/active again.

**Failure mode B — subagents bypass Ralph tool restrictions:** AgentControl checks whether the requested agent is enabled for the session, but the worker tool allowlist then falls back to the worker session’s active tools unless the agent definition or execution policy has an allowlist.  So a Ralph loop can restrict the child session’s direct tools, but a permitted subagent can still receive default worker tools such as bash/edit/write unless the subagent definition happens to restrict them.

**Best repair direction:** Make Ralph contract enforcement central and transitive. Under Ralph ownership, the agents-menu transform must not add `agent` unless `contract.tools.activeNames` includes it. AgentControl should receive the Ralph loop contract and derive a child execution policy from it, clamped further by the selected agent definition. Add tests for: “contract disables agent,” “contract enables agent but disables bash/write,” and “agent menu cannot reintroduce a disabled tool.”

---

### P1 — Autoresearch uses stale command contexts after session replacement, while Ralph already had to build a special replacement-safe boundary

**Affected files:** `extensions/tau/src/autoresearch/index.ts`, `extensions/tau/src/ralph/index.ts`, Ralph stale-context tests.

**Why it matters:** Ralph contains a dedicated command boundary that uses `newSession(... withSession ...)` and `switchSession(... withSession ...)`, binds the replacement context, and applies tools/profiles to the live replacement session.  The tests explicitly encode the problem: after session replacement, using the captured command context is stale and wrong.

**Failure mode:** Autoresearch’s `createChildSession` calls `ctx.newSession({ parentSession })` without a replacement `withSession` callback, then immediately reads `commandSessionRef(ctx)`, applies the execution profile using the old `ctx`, attaches child ownership using `ctx.cwd`, and sends a follow-up prompt globally through `pi.sendUserMessage`.  If Pi behaves like the Ralph stale-context test assumes, autoresearch may attach the controller as child, apply profile/tools to the wrong session, or send the trial prompt to the wrong session.

**Best repair direction:** Extract Ralph’s session-boundary abstraction into the shared loop engine and make Autoresearch use it. No background loop should retain an old `ExtensionCommandContext` after `newSession` or `switchSession`. The prompt should be delivered through the replacement child context, not a global follow-up send.

---

### P1 — Shared LoopEngine has read/modify/write races and no per-task serialization

**Affected files:** `extensions/tau/src/services/loop-engine.ts`, `extensions/tau/src/loops/repo.ts`, `extensions/tau/src/ralph/config-service.ts`, `extensions/tau/src/autoresearch/index.ts`.

**Why it matters:** LoopEngine is now the shared state machine for both Ralph and Autoresearch, but each transition loads state, computes a next state, and saves it without a per-task mutex or compare-and-swap. `pauseLoop`, `stopLoop`, `attachChildSession`, and `clearChildSession` are independent read/modify/write transitions.

**Failure mode:** Two commands can interleave and lose updates. Examples: attach-child races with pause; config mutation races with iteration completion; two `autoresearch_run` calls can both observe no pending run before either write wins; direct Autoresearch writes can overwrite LoopEngine lifecycle changes. Because Autoresearch also performs synchronous direct state writes outside LoopRepo/LoopEngine, the effective transaction boundary is even weaker.

**Best repair direction:** Add per-task serialization in LoopEngine and make it the only writer for loop state. A simple in-process mutex per normalized root + task ID is the minimum; a durable version field with CAS or atomic compare is better. Move pending-run mutations, child clearing, and configuration mutation into LoopEngine transitions. Direct `readCanonicalLoopState` / `writeCanonicalLoopState` paths should be removed or made private to the repo with the same locking/version checks.

---

### P2 — Capability capture says “current runtime,” but actually captures Ralph defaults

**Affected files:** `extensions/tau/src/ralph/resolver.ts`, `extensions/tau/src/ralph/index.ts`, tests around default tools.

**Why it matters:** The contract capture input includes `activeTools` and `enabledAgents`, and comments say the loop captures current runtime state. But `captureToolContract` ignores `activeTools` and selects a hard-coded Ralph default set; `captureAgentContract` ignores `enabledAgents` and defaults to `finder` when present.  Tests confirm the default active tool and finder behavior. 

**Failure mode:** A user may disable a tool in the ambient Pi session and expect Ralph to pin that active state, but Ralph starts with its own defaults. Conversely, if the UI says a tool/agent is disabled outside Ralph, the assistant may see it as enabled inside Ralph. This is a user-visible policy mismatch.

**Best repair direction:** Choose one semantic and make it explicit. Either rename this to “Ralph default contract” and present it in `/ralph configure` before start, or actually capture active tools and enabled agents from the current runtime/menu state. In either case, persist exactly what the UI shows and apply exactly what is persisted.

---

### P2 — Arbitrary Ralph task paths and canonical task files are mixed

**Affected files:** `extensions/tau/src/ralph/index.ts`, `extensions/tau/src/services/ralph.ts`, `extensions/tau/src/ralph/repo.ts`, `extensions/tau/src/loops/repo.ts`.

**Why it matters:** The ADR says loop-owned task files live only under `.pi/loops/tasks/**`.  But `/ralph start <name|path>` accepts any path-like target and uses that as `taskFile`.  `createDraftLoopForConfiguration` can create canonical loop state and then rewrite `state.taskFile` to a noncanonical input path.  Tests explicitly preserve noncanonical task paths. 

**Failure mode:** The engine may create a canonical `.pi/loops/tasks/<id>.md` while Ralph state points elsewhere. Archiving copies the noncanonical content into canonical archive paths and may remove the source if it lives under the active task root.  This increases the chance that the UI, engine, path protection, and agent instructions refer to different files.

**Best repair direction:** Make all loop tasks canonical. For `/ralph start path.md`, import/copy the external file into `.pi/loops/tasks/<task-id>.md` at create time and store the original source path only as metadata if useful. Remove state shapes that point `taskFile` outside the canonical task store.

---

### P2 — Session identity stores `sessionId` but most ownership logic only trusts `sessionFile`

**Affected files:** `extensions/tau/src/services/loop-engine.ts`, `extensions/tau/src/ralph/repo.ts`, `extensions/tau/src/services/ralph.ts`, tests.

**Why it matters:** The ADR says session IDs drive live runtime ownership while session file paths support recovery/UI/restart reconciliation.  The LoopEngine implementation compares only `sessionFile`.  Tests also assert that session files, not project session IDs, determine loop ownership.  Ralph’s adapter often normalizes missing session references by using the file path as both `sessionId` and `sessionFile`. 

**Failure mode:** If session files are reused, copied, restored, or referenced from stale contexts, a live runtime can claim ownership based solely on path. The stored `sessionId` gives a false sense of precision because it is not the primary live check in the engine.

**Best repair direction:** Split live ownership from recovery identity. For active in-process operations, require both session ID and session file to match when both are available. On restart, support an explicit reconciliation path that uses file-only matching to rebind or mark the loop as needing manual resolution. Ralph should pass real `ctx.sessionManager.getSessionId()` through its boundary instead of fabricating `sessionId = sessionFile`.

---

### P2 — Autoresearch direct file I/O bypasses LoopRepo/LoopEngine validation and lifecycle semantics

**Affected files:** `extensions/tau/src/autoresearch/index.ts`, `extensions/tau/src/loops/repo.ts`, `extensions/tau/src/services/loop-engine.ts`.

**Why it matters:** The shared engine is supposed to own lifecycle, task discovery, persistence, and explicit iteration finalization.  Autoresearch uses LoopEngine for create/start/resume/pause/stop, but it also reads phase snapshots and loop state directly from files, writes run records directly, and relies on command-side guards for pending-run invariants.

**Failure mode:** Some transitions go through LoopEngine validation, while others mutate state outside the shared state machine. That makes it possible for pending-run state, child ownership, run artifacts, and lifecycle state to diverge. It also prevents shared locking/versioning fixes from protecting Autoresearch unless these direct writes are removed.

**Best repair direction:** Move Autoresearch pending-run creation, run record persistence, `autoresearch_done`, phase lookup, and child clearing into LoopEngine/LoopRepo services. Autoresearch tools should call one domain service method per transition and receive a typed result.

---

### P2 — Autoresearch event waiting can miss already-fired agent-end events

**Affected files:** `extensions/tau/src/services/autoresearch-loop-runner.ts`, `extensions/tau/src/autoresearch/index.ts`.

**Why it matters:** The runner stores only current waiters in `waitingAgentEnds`. `resolveAgentEnd` is a no-op if no waiter exists for that session file.  The Autoresearch loop creates/uses a child, queues a prompt, and then waits for `agent_end`. 

**Failure mode:** If `agent_end` is delivered before the background loop has registered its waiter, the completion event is lost. The runner then waits until timeout and may pause the loop even though the child already ended. Ralph’s iteration signal bridge has queued/waiting states, but AutoresearchLoopRunner does not.

**Best repair direction:** Use the same event bridge semantics for both loop kinds: queue completion events by session file until consumed, include a bounded TTL, and consume exactly once. Better: make the shared LoopEngine own iteration wait/settlement for both Ralph and Autoresearch.

---

### P2 — Configuration mutation deferral is not tied to an engine transaction or child lifecycle

**Affected files:** `extensions/tau/src/ralph/config-service.ts`, `extensions/tau/src/services/ralph.ts`, `extensions/tau/src/services/loop-engine.ts`.

**Why it matters:** The config service defers non-scalar mutations when the loop is active and has an active child. Scalars apply immediately. That is a reasonable policy, but it is implemented by loading state, checking `activeIterationSessionFile`, and saving directly through the Ralph adapter. It is not serialized against child attach/clear or loop pause/stop.

**Failure mode:** A mutation can be applied immediately just before a child is attached, or deferred based on stale child state that is about to clear. That can make tool/agent/execution/sandbox restrictions differ between the controller, current child, next child, and UI.

**Best repair direction:** Put configuration mutation into LoopEngine as a task transition. The transition should read the current lifecycle/child state under the same per-task lock used by `attachChildSession` and `clearChildSession`. “Applies now vs next iteration” should be decided atomically.

---

### P3 — Runtime schema migration conflicts with the repository’s “fail fast/no fallback” direction

**Affected files:** `extensions/tau/src/loops/schema.ts`, `extensions/tau/src/ralph/schema.ts`, `AGENTS.md`.

**Why it matters:** The project instructions say final-form code should avoid fallback logic and migrations, and invalid states should fail fast. Yet `normalizeLoopPersistedState` silently inserts missing Ralph fields such as `pendingDecision`, `sandboxProfile`, `metrics`, `capabilityContract`, and `deferredConfigMutations`; the Ralph schema has similar compatibility normalization.

**Failure mode:** Old or partially written state can silently become runnable with an empty capability contract, default metrics, or null sandbox profile. That hides migration errors and makes policy behavior dependent on defaults.

**Best repair direction:** Replace runtime normalization with a one-shot importer or explicit migration command. Steady-state decode should fail with a clear error and tell the operator how to import/repair the state.

---

### P3 — Tool visibility is inconsistent for Autoresearch and Ralph control surfaces

**Affected files:** `extensions/tau/src/autoresearch/index.ts`, `extensions/tau/src/ralph/index.ts`, `extensions/tau/src/agents-menu/index.ts`.

**Why it matters:** The ADR says autoresearch tools are valid only in the active child session.  The implementation toggles `autoresearch_done` based on active child context, but `autoresearch_run` remains registered and visible enough to be called outside valid context, relying on runtime errors.  Ralph similarly relies on active-tool transforms and session ownership caching that can drift.

**Failure mode:** The assistant sees tools that are invalid in the current session and may waste turns calling them. The user sees a control surface that does not match the actual lifecycle state.

**Best repair direction:** Treat tool visibility as part of the loop contract. For Autoresearch, enable both `autoresearch_run` and `autoresearch_done` only inside the active child, and hide both from controller/unowned sessions. For Ralph, ensure `ralph_continue`/`ralph_finish` are enabled only for the active child and that no later transform can contradict that state.

---

## Architectural/design concerns

### P1 design concern — The shared engine is still too thin; workflow code owns too much lifecycle

The ADR says LoopEngine owns lifecycle, controller/child orchestration, explicit iteration finalization, persistence, and status integration.  In practice, Ralph owns a session boundary, global iteration signal bridge, pending-decision semantics, and capability appliers; Autoresearch owns child creation, prompt delivery, pending-run mutation, run artifacts, and workspace finalization. That makes LoopEngine more of a state-file helper than a true engine.

**Refactor direction:** Promote these concepts into the shared engine:

* normalized workspace root,
* per-task lock/versioning,
* controller/child creation boundary,
* child prompt delivery,
* iteration start/end/finalize,
* owned-session tool/profile policy application,
* blocked/manual-resolution transitions.

Ralph and Autoresearch should supply workflow prompts, domain validation, and finalization payload schemas, not their own lifecycle machinery.

---

### P1 design concern — Policy is split between “what the assistant sees” and “what the tool actually permits”

The visible assistant tool list is produced by active-tool transforms; actual execution is checked by agents-menu selection, Ralph contract, worker allowlists, sandbox policy, and command/tool runtime checks. The agents-menu can add/remove `agent` based on enabled agents, while Ralph applies active tools from its contract separately.

**Refactor direction:** Build one session policy object per session:

```ts
type EffectiveSessionPolicy = {
  loopOwner?: { kind: "ralph" | "autoresearch"; taskId: string; role: "controller" | "child" };
  activeTools: readonly string[];
  enabledAgents: readonly string[];
  executionProfile: ExecutionProfile;
  sandboxProfile: ResolvedSandboxConfig;
};
```

Every UI menu, active-tool transform, worker spawn, and tool execution check should consume this same object. Do not let menus synthesize tool activation independently.

---

### P2 design concern — Ralph legacy adapter keeps old state names and semantics alive

`RalphRepo` adapts canonical `LoopPersistedState` into a legacy-ish `LoopState` with `name`, `status`, `controllerSessionFile`, `activeIterationSessionFile`, and `executionProfile`. It also converts back to persisted state and sometimes fabricates session refs.

**Refactor direction:** Delete the legacy Ralph state adapter once command/UI code can speak `RalphLoopPersistedState` directly. This will remove a class of mapping bugs around lifecycle/status, execution profile naming, task file paths, and session identity.

---

## Speculative or needs targeted validation

These are plausible from the packaged code, but I would want targeted tests before calling them fully confirmed.

1. **Ralph controller capability application may be silently skipped after session replacement in some branches.** The command boundary has fallback paths that may return applied success for controller replacement even when no live applier is present, while child application is stricter. This deserves a test where controller contract removes a tool and the replacement context lacks `setActiveTools`.

2. **Ralph run cleanup can leave an orphan child session if applying child policy/profile fails after `newSession`.** Ralph creates a child session, applies policy/profile, and then attaches ownership. If application fails before attach, it pauses state, but the created session may still exist without loop ownership. I did not see a robust shared rollback path equivalent to “delete/reclaim child session.”

3. **Autoresearch phase changes during active runs may be insufficiently blocked.** Phase identity is well specified in the ADR, and LoopEngine syncs task contract on start/resume, but direct task edits during an active pending run could still interact poorly with direct state I/O and run finalization. A test should edit phase-defining task frontmatter between `autoresearch_run` and `autoresearch_done`.

---

## Highest-impact repair plan

1. **Stop the P0 workspace mutations immediately.** Remove auto-commit/auto-revert from `autoresearch_done` and update tests to match the ADR.

2. **Normalize loop root everywhere.** Add one resolver and pass normalized loop root to LoopEngine, Ralph, Autoresearch, agents-menu cache, and LoopRepo.

3. **Make LoopEngine the only loop-state writer.** Add per-task serialization/versioning and move Autoresearch pending-run/finalization transitions into the engine.

4. **Unify session replacement handling.** Extract Ralph’s replacement-safe boundary and use it for both Ralph and Autoresearch.

5. **Centralize policy.** One effective session policy should drive tool visibility, agent menu visibility, worker spawn permissions, and execution/sandbox profile application.

6. **Delete the Ralph legacy adapter once callers are migrated.** The adapter currently preserves too many old semantics and creates mapping risk around ownership and task paths.

The biggest conceptual rewrite I would recommend is **not** rewriting Ralph itself first; it is rewriting the **shared loop engine/session-policy boundary** so Ralph and Autoresearch stop implementing lifecycle and policy enforcement independently.
