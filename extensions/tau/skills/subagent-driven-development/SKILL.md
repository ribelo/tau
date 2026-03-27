---
name: subagent-driven-development
description: Execute beads-tracked work by dispatching agents per task/epic with two-stage review. Beads is the spec — agents read it, implement it, get reviewed against it. Use when tasks are formalized in beads and need systematic execution.
---

# Subagent-Driven Development

## Overview

Execute beads-tracked work by dispatching agents. Beads tasks ARE the spec — the orchestrator does not repeat their content in delegation messages.

**Core principle:** Beads is the source of truth. Agents read beads. Orchestrator coordinates, not transcribes.

## When to Use

- Beads tasks exist with description, design, and acceptance criteria
- Work needs systematic execution with review gates
- Multiple tasks need coordinated delivery

## Delegation Rules

### Beads is the spec

Every delegation message references a beads task ID. The agent reads the task with `bd show <id>` to get description, design, and acceptance criteria. The orchestrator does NOT paste task content into the delegation prompt.

### No code in delegation

The orchestrator does not provide code snippets to implementer agents. Agents are skilled developers — they write the code.

**Exception:** Shared contracts (interfaces, enums, type shapes) that cross task boundaries and must match exactly MAY be included when the contract is not yet in the codebase.

### Minimal delegation message

A delegation message contains:
1. The beads task ID (or epic ID for multi-task delegation)
2. Project-level context the agent cannot discover (test commands, gate commands, key conventions)
3. Constraints not in the beads task (e.g., "do not commit", "do not touch file X")

Nothing else. No restating the spec. No step-by-step instructions.

## Agent Selection

### One task, independent
`agent spawn smart` — fast, focused, clean context.

### One task, complex or cross-cutting
`agent spawn deep` — more reasoning, handles multi-file changes well.

### Multiple sequential tasks (same epic)
`agent spawn deep` with the epic ID — deep agents handle multi-step work well. When tasks must be done in order and cannot be parallelized, one deep agent working through the sequence is faster than spawn/wait/spawn cycles.

Reuse the same agent with `agent send` for subsequent tasks in the sequence:

```text
agent spawn deep "Implement tau-abc.1
Read the task: bd show tau-abc.1
..." -> impl-1

agent wait [impl-1]

agent send [impl-1] "Now implement tau-abc.2
Read the task: bd show tau-abc.2"

agent wait [impl-1]
```

### Multiple independent tasks (parallelizable)
Spawn separate agents — one per task, in parallel. Only when tasks touch disjoint files.

### Review
`agent spawn review` — always a separate agent from the implementer.

## Per-Task Workflow

### Step 0: Claim

```bash
bd update tau-abc123 --status in_progress
```

### Step 1: Dispatch Implementer

```text
agent spawn deep "Implement tau-abc123

Read the task: bd show tau-abc123
Follow its description, design, and acceptance criteria.

Project context:
- Run gate: npm run gate
- Do not commit or change git state
- If the spec is ambiguous, stop and ask before guessing"
```

```text
agent wait [impl_id]
```

### Step 2: Two-Stage Review

Spawn ONE reviewer. It handles spec compliance first, then code quality.

**Phase 1 — Spec compliance:**

```text
agent spawn review "Review tau-abc123 for spec compliance

Read the spec: bd show tau-abc123
Check every acceptance criterion is met.

OUTPUT: PASS or list of specific gaps"
```

```text
agent wait [reviewer_id]
```

If gaps found → fix with implementer → `agent send` reviewer to re-check.

**Phase 2 — Code quality:**

```text
agent send [reviewer_id] "Spec is PASS. Review code quality for the same implementation.

CHECK: conventions, error handling, naming, test coverage, security, no scope creep.
OUTPUT: APPROVED or REQUEST_CHANGES with specifics"
```

```text
agent wait [reviewer_id]
```

If issues found → fix → `agent send` reviewer to re-check (both quality AND spec still holds).

Close reviewer after APPROVED:

```text
agent close [reviewer_id]
```

### Step 3: Mark Complete

```bash
bd close tau-abc123 --reason "Implemented and reviewed"
```

## Multi-Task Sequential Example

When an epic has tasks that must be done in order:

```text
[bd update tau-abc.1 --status in_progress]

agent spawn deep "Implement tau-abc.1
Read the task: bd show tau-abc.1
Project context: npm run gate, do not commit" -> impl

agent wait [impl]

[Review tau-abc.1 as above]

[bd close tau-abc.1 --reason "Implemented and reviewed"]
[bd update tau-abc.2 --status in_progress]

agent send [impl] "Now implement tau-abc.2
Read the task: bd show tau-abc.2"

agent wait [impl]

[Review tau-abc.2 as above]

[bd close tau-abc.2 --reason "Implemented and reviewed"]
```

The deep agent accumulates codebase context across tasks — it already knows the code from task 1 when starting task 2. This is faster than spawning fresh agents for sequential work.

## Multi-Task Parallel Example

When tasks touch disjoint files:

```text
[bd update tau-abc.1 --status in_progress]
[bd update tau-abc.2 --status in_progress]

agent spawn smart "Implement tau-abc.1 ..." -> impl-1
agent spawn smart "Implement tau-abc.2 ..." -> impl-2

agent wait [impl-1, impl-2]

[Review each independently]
```

## Final Integration Review

After ALL tasks in an epic are complete:

```text
agent spawn review "Integration review for epic tau-abc

All tasks complete. Check:
- Components work together
- No contract drift between layers
- Tests pass at correct scope
- Ready for merge"
```

## Verify and Commit

The orchestrator session owns git actions:

```bash
npm run gate
git diff --stat
git add -A && git commit -m "feat: complete auth feature"
bd close tau-abc --reason "All tasks implemented and reviewed"
```

## Red Flags

- Pasting full task specs into delegation messages (use beads IDs)
- Providing code snippets to implementers (let them write code)
- Skipping reviews
- Starting quality review before spec compliance PASS
- Spawning new reviewer for re-review (use `agent send`)
- Letting implementer self-review
- Closing beads task before both review stages pass
- Telling agents to commit or change git state
- Spawning fresh agents for sequential dependent work (reuse with `send`)

## Integration

### With plan mode

Plan mode creates the beads tasks. SDD executes them:
1. Plan mode → `<proposed_plan>` → user accepts → beads epics/tasks created
2. SDD → reads beads → dispatches agents → delivers working code

### With review

Two-phase review per task (spec then quality), one reviewer agent reused via `send`.

### With test-driven development

Include "follow TDD" in delegation messages. Agents write failing tests first, then implement.
