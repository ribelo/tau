---
name: subagent-driven-development
description: Execute implementation plans by dispatching fresh agents per task with two-stage review (spec compliance then code quality). Use when you have a plan with independent tasks where quality matters.
---

# Subagent-Driven Development

Execute implementation plans by dispatching fresh agents per task with systematic two-stage review.

**Core principle:** Fresh agent per task + two-stage review (spec then quality) = high quality, fast iteration.

## When to Use

- You have an implementation plan (from beads tasks, user requirements, or planning skill)
- Tasks are mostly independent
- Quality and spec compliance are important

## The Process

### 1. Parse Plan into Tasks

Extract ALL tasks upfront. Create beads issues or a local checklist. Each task = 2-5 minutes of focused work.

**Too big:** "Implement user authentication system"
**Right size:** "Create User model", "Add password hashing function", "Create login endpoint"

### 2. Per-Task Workflow

For EACH task, run these four steps in order:

#### Step 1: Dispatch Implementer

Spawn a `smart` or `deep` agent with complete context. Provide the full task spec inline — agents cannot read your plan.

```
agent spawn smart "Implement Task 1: Create User model

TASK SPEC:
- Create: src/models/user.ts
- Add User class with email and passwordHash fields
- Use bcrypt for password hashing
- Include validation

PROJECT CONTEXT:
- TypeScript, Effect-TS patterns
- Existing models in src/models/
- Tests use vitest, run from project root
- bcrypt already in dependencies

INSTRUCTIONS:
1. Write failing test first
2. Implement minimal code to pass
3. Run tests, verify pass
4. Commit with descriptive message"
```

#### Step 2: Dispatch Spec Compliance Reviewer

After the implementer completes, spawn a `review` agent to verify against the original spec:

```
agent spawn review "Review spec compliance for Task 1: User model

ORIGINAL SPEC:
- File: src/models/user.ts with User class
- Fields: email (string), passwordHash (string)
- bcrypt for password hashing
- Validation included

CHECK:
- All requirements from spec implemented?
- File paths match spec?
- Function signatures match spec?
- Nothing extra added (no scope creep)?

OUTPUT: PASS or list specific spec gaps."
```

**If gaps found:** spawn a new `smart` agent to fix them, then re-run spec review. Proceed only on PASS.

#### Step 3: Dispatch Code Quality Reviewer

After spec compliance passes, spawn a `review` agent:

```
agent spawn review "Review code quality for Task 1 implementation

FILES TO REVIEW:
- src/models/user.ts
- tests/models/user.test.ts

CHECK:
- Follows project conventions and style?
- Proper error handling?
- Adequate test coverage?
- No obvious bugs or security issues?

OUTPUT:
- Critical: [must fix]
- Important: [should fix]
- Minor: [optional]
- Verdict: APPROVED or REQUEST_CHANGES"
```

**If changes requested:** fix with a new implementer agent, then re-review. Proceed only on APPROVED.

#### Step 4: Mark Complete

Update the beads issue or checklist. Move to next task.

### 3. Final Integration Review

After ALL tasks complete, spawn a `review` agent for the full implementation:

```
agent spawn review "Review full implementation for integration issues

All tasks complete. Check:
- Do all components work together?
- Any inconsistencies between tasks?
- All tests passing?
- Ready for merge?"
```

### 4. Verify and Commit

Run the project gate (tests, typecheck, lint). Review all changes. Final commit.

## Coordination Rules

- **One implementer per file set.** Two agents editing the same files causes conflicts. If tasks touch shared files, run them sequentially.
- **Spec review before quality review.** Spec catches under/over-building; quality ensures well-built code. Wrong order wastes review effort.
- **Fresh agent per step.** Implementer, spec reviewer, and quality reviewer are separate agents. An implementer reviewing its own code misses issues.
- **Provide full context inline.** Agents start with empty context. Include the task spec, relevant file paths, project conventions, and any decisions made in prior tasks.

## Handling Issues

**Agent asks questions:** Answer clearly with additional context before proceeding.

**Reviewer finds issues:** Spawn a new fix agent with specific instructions about what went wrong. Re-review after fix. Repeat until approved.

**Agent fails a task:** Spawn a new agent with instructions about what went wrong. Keep the controller session clean by delegating fixes.

## Red Flags

- Starting implementation without a plan
- Skipping either review stage
- Proceeding with unfixed critical/important issues
- Two agents editing the same files simultaneously
- Providing the plan as a file path instead of inline text
- Skipping the re-review after fixes
- Letting the implementer self-review (both stages still required)

## Integration with Other Skills

| Skill | Relationship |
|---|---|
| **planning** | Creates the plan this skill executes |
| **review** | Same review dimensions used for final integration review |
| **agent-delegation** | Covers the `agent` tool mechanics — when to delegate vs work directly |

## Remember

```
Fresh agent per task
Two-stage review every time
Spec compliance FIRST
Code quality SECOND
Never skip reviews
Catch issues early
```
