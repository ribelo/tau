---
name: subagent-driven-development
description: Guide for executing implementation plans with fresh pi agents per task, beads-backed task tracking, and two-stage review. Use when tasks are mostly independent and the job needs systematic spec compliance, code quality checks, and a final integration review.
---

# Subagent-Driven Development

## Overview

Execute implementation plans by dispatching fresh agents per task with systematic two-stage review.

**Core principle:** Fresh agent per task + two-stage review (spec then quality) = high quality, fast iteration.

## When to Use

Use this skill when:
- There is an implementation plan (from the planning skill, beads tasks, or clear user requirements)
- Tasks are mostly independent
- Quality and spec compliance are important
- Automated review between tasks is desirable
- The work is large enough that accumulated controller-session context would become noisy

**vs. manual execution:**
- Fresh context per task (no confusion from accumulated state)
- Automated review process catches issues early
- Consistent quality checks across all tasks
- Agents can ask questions before starting work
- Beads keeps progress visible and recoverable across handoffs or context compaction

## The Process

### 1. Read and Parse Plan

Read the plan file. Extract ALL tasks with their full text and context upfront. Create beads tasks if they do not already exist.

```bash
# Read the plan once
read docs/plans/auth-feature.md

# Create beads tasks for every plan item if the plan is not already tracked
bd create "Create User schema with email field" --type task --priority 2 --description "From auth plan: create src/domain/user.ts with email and passwordHash fields."
bd create "Add password hashing service" --type task --priority 2 --description "From auth plan: add src/services/password.ts with hash + verify helpers."
bd create "Create login handler" --type task --priority 2 --description "From auth plan: add src/http/routes/login.ts that validates credentials and issues a session token."
```

If the plan is already represented in beads, do not create duplicates. Read the task descriptions once, collect the task ids, and use those ids throughout execution:

```bash
bd show tau-abc123
bd show tau-def456
bd show tau-ghi789
```

**Key:** Read the plan ONCE. Extract everything. Do not make agents read the plan file — provide the full task text directly in context.

### 2. Per-Task Workflow

For EACH task in the plan:

#### Step 0: Claim the Task

Move the beads task into active work before dispatching the implementer:

```bash
bd update tau-abc123 --status in_progress
```

Use the issue description as the authoritative task summary, but still paste the relevant spec into the agent prompt so the agent has everything it needs without re-discovering context.

#### Step 1: Dispatch Implementer Agent

Use `agent spawn smart` for small, local tasks. Use `agent spawn deep` when the task spans multiple files, changes shared contracts, or requires careful reasoning.

Use complete context:

```text
agent spawn deep "Implement Task 1: Create User schema with email and passwordHash fields

TASK FROM PLAN / BEADS:
- Task ID: tau-abc123
- Create: src/domain/user.ts
- Add User schema with email and passwordHash fields
- Use Effect Schema or tagged data patterns already used in src/domain/
- Export constructors/decoders used by auth flows
- Include a safe formatter for debugging that never exposes raw password input

FOLLOW TDD:
1. Write a failing test in test/domain/user.test.ts
2. Run: npm test -- test/domain/user.test.ts (verify FAIL)
3. Write the minimal implementation
4. Run: npm test -- test/domain/user.test.ts (verify PASS)
5. Run: npm test (verify no regressions in touched areas)
6. Report:
   - files changed
   - tests run and pass counts
   - open questions or assumptions

PROJECT CONTEXT:
- TypeScript 5.x with Effect-TS patterns
- Domain modules live in src/domain/
- Tests use Vitest, run from project root
- Reuse existing naming and error-handling conventions
- Do not commit or change git state
- If the spec is ambiguous, stop and ask before guessing"
```

Then wait for the result:

```text
agent wait [impl_id]
```

**Key:** Give the agent the task text, file paths, conventions, verification steps, and constraints inline. Do not assume the agent will read the same surrounding documents already read in the controller session.

#### Step 2: Dispatch Spec Compliance Reviewer

After the implementer completes, spawn a reviewer. **Keep the reviewer alive** — if issues are found, you will `send` it a follow-up instead of spawning a new one:

```text
agent spawn review "Review whether Task 1 implementation matches the original spec

ORIGINAL TASK SPEC:
- Create src/domain/user.ts with User schema
- Fields: email (string), passwordHash (string)
- Use existing password hashing service contracts
- Export constructors/decoders required by auth flows
- Include safe debugging output without leaking secrets

CHECK:
- [ ] All requirements from the spec implemented?
- [ ] File paths match the spec?
- [ ] Export names and signatures match the spec?
- [ ] Behavior matches the expected contract?
- [ ] Nothing extra added (no scope creep)?

OUTPUT:
- PASS
or
- Specific spec gaps that must be fixed before proceeding"
```

Then wait:

```text
agent wait [spec_review_id]
```

**If spec issues are found:** Fix the gaps with an implementer agent, then **`send` the same reviewer** a re-review request instead of spawning a new one. The reviewer already has the full context of what it found — a fresh reviewer would lose that:

```text
agent send [spec_review_id] "The following spec gaps have been fixed:
- [describe what was fixed]

Please re-review the same files against the original spec. Confirm PASS or list remaining gaps."
```

```text
agent wait [spec_review_id]
```

Repeat the send → wait loop until the reviewer returns PASS. Then **close** the spec reviewer:

```text
agent close [spec_review_id]
```

#### Step 3: Dispatch Code Quality Reviewer

After spec compliance passes, spawn a quality reviewer. Same rule — **keep it alive** for re-review loops:

```text
agent spawn review "Review code quality for Task 1 implementation

FILES TO REVIEW:
- src/domain/user.ts
- test/domain/user.test.ts

CHECK:
- [ ] Follows project conventions and style?
- [ ] Proper error handling?
- [ ] Clear variable/type/function names?
- [ ] Adequate test coverage?
- [ ] No obvious bugs or missed edge cases?
- [ ] No security issues?
- [ ] Effect usage is explicit and unsurprising?

OUTPUT FORMAT:
- Critical Issues: [must fix before proceeding]
- Important Issues: [should fix]
- Minor Issues: [optional]
- Verdict: APPROVED or REQUEST_CHANGES"
```

Then wait:

```text
agent wait [quality_review_id]
```

**If quality issues are found:** Fix the issues, then **`send` the same reviewer** a re-review:

```text
agent send [quality_review_id] "The following quality issues have been addressed:
- [describe what was fixed]

Please re-review and confirm APPROVED or list remaining issues."
```

```text
agent wait [quality_review_id]
```

Repeat until APPROVED. Then close the quality reviewer:

```text
agent close [quality_review_id]
```

#### Step 4: Mark Complete

Once implementation, spec review, and quality review are all complete, close the beads task:

```bash
bd close tau-abc123 --reason "Implemented, spec-reviewed, quality-reviewed"
```

If additional notes matter for later tasks, record them before closing:

```bash
bd update tau-abc123 --note "User schema exported makeUser and decodeUser helpers for login/register flows."
```

### 3. Final Review

After ALL tasks are complete, dispatch a final integration reviewer:

```text
agent spawn review "Review the entire implementation for consistency and integration issues

ALL TASKS FROM THE PLAN ARE COMPLETE. Review the full implementation:
- Do all components work together?
- Any inconsistencies between tasks?
- Any contract drift between domain, service, and HTTP layers?
- Are tests passing at the right scope?
- Is the change ready for orchestrator verification and merge?"
```

Then wait:

```text
agent wait [integration_review_id]
```

### 4. Verify and Commit

Run the relevant project gate. Review all changes. The orchestrator session owns git actions.

```bash
# Run the project gate or the full verification stack
npm run gate

# Review all changes
git diff --stat

# Final commit if repo policy permits and verification is green
git add -A && git commit -m "feat: complete auth feature implementation"
```

If the project uses beads to track the parent feature, close or update that feature issue after the full integration review passes.

## Task Granularity

**Each task = 2-5 minutes of focused work.**

**Too big:**
- "Implement user authentication system"

**Right size:**
- "Create User schema with email and passwordHash fields"
- "Add password hashing service"
- "Create login handler"
- "Add session token generator"
- "Create registration handler"

The point is not to create tiny meaningless tasks. The point is to make each task small enough that:
- the agent can hold the whole spec in its working context
- the review can be specific and fast
- failures are cheap to re-run
- cross-task bugs do not compound before being noticed

## Red Flags — Never Do These

- Start implementation without a plan
- Skip reviews (spec compliance OR code quality)
- Proceed with unfixed critical or important issues
- Dispatch multiple implementation agents for tasks that touch the same files
- Make an agent read the plan file (provide full text in context instead)
- Skip scene-setting context (the agent needs to understand where the task fits)
- Ignore agent questions (answer before letting them proceed)
- Accept "close enough" on spec compliance
- Skip review loops (reviewer found issues → implementer fixes → review again)
- Let implementer self-review replace actual review (both are needed)
- **Start code quality review before spec compliance is PASS** (wrong order)
- Move to the next task while either review has open issues
- Tell write agents to commit, rebase, or change git state
- Close the beads task before both review stages pass
- **Spawn a new reviewer for re-review when the original is still alive** — use `agent send` to the existing reviewer instead; it already has the context of what it found

## Handling Issues

### If the Agent Asks Questions

- Answer clearly and completely
- Provide additional context if needed
- Do not rush the agent into implementation
- If the question is small and continuation context matters, respond to the same agent
- If the clarification changes the spec materially, spawn a fresh implementer with the updated task text

### If Reviewer Finds Issues

- An implementer agent (or a new one) fixes them
- **`send` the same reviewer** a re-review request — do NOT spawn a fresh reviewer
- The reviewer already knows what it found and can verify the fix was correct
- Repeat the fix → send → wait loop until approved
- Close the reviewer only after it returns PASS or APPROVED
- Do not skip the re-review

### If the Agent Fails a Task

- Dispatch a new fix agent with specific instructions about what went wrong
- Include the failed attempt's result summary so the new agent starts informed
- Keep the controller session clean by delegating the fix instead of hand-editing ad hoc
- Add a beads note if the failure reveals a broader risk or follow-up

## Efficiency Notes

**Why fresh agent per task:**
- Prevents context pollution from accumulated state
- Each agent gets clean, focused context
- No confusion from prior tasks' code or reasoning

**Why two-stage review:**
- Spec review catches under-building or over-building early
- Quality review ensures the implementation is well-built
- Issues get caught before they compound across tasks

**Why beads per task:**
- Progress survives context compaction and handoffs
- Task status is visible outside the current session
- Follow-up issues can be linked to concrete task ids
- Completion is explicit, not implied

**Cost trade-off:**
- More agent invocations (implementer + 2 reviewers per task)
- More coordination than hand-editing everything in one session
- But catches issues early, which is cheaper than debugging compounded mistakes later

This workflow spends more coordination effort up front to buy lower rework cost later. That trade is usually worth it when the work is multi-step, user-visible, or contract-heavy.

## Integration with Other Skills

### With planning

This skill EXECUTES plans created by the planning skill:
1. User requirements → planning → implementation plan
2. Implementation plan → subagent-driven-development → working code

### With agent-delegation

This skill is a specialization of the broader delegation model:
1. agent-delegation explains when delegation is worth the overhead
2. subagent-driven-development defines the exact per-task implementation/review loop
3. Use agent-delegation rules to decide what can run in parallel and what must stay serialized

### With review

The two-stage review process IS the review flow:
1. Spec compliance review checks whether the task matches the plan
2. Code quality review checks whether the implementation is solid
3. Final integration review checks cross-task consistency and merge readiness

### With test-driven development

Implementer agents should follow TDD:
1. Write the failing test first
2. Implement the minimal code
3. Verify the test passes
4. Run the relevant wider suite
5. Report what changed and what passed

Include test-first instructions in every implementer prompt.

### With analysis

If an agent encounters bugs or confusing behavior during implementation:
1. Pause feature work long enough to find the root cause
2. Use analysis patterns to understand the failure instead of guessing
3. Add or extend a regression test
4. Resume implementation only after the behavior is explained

## Example Workflow

```text
[Read plan: docs/plans/auth-feature.md]
[Create beads tasks: tau-a1, tau-a2, tau-a3, tau-a4, tau-a5]

--- Task 1: Create User schema ---
[bd update tau-a1 --status in_progress]

[agent spawn deep "Implement Task 1: Create User schema"] -> impl-1
[agent wait [impl-1]]
  Implementer: "Should email be globally unique or tenant-scoped?"
  You: "Globally unique"
  Implementer: Implemented, 3/3 tests passing.

[agent spawn review "Spec compliance for Task 1"] -> spec-1
[agent wait [spec-1]]
  Spec reviewer: PASS — all requirements met

[agent spawn review "Code quality for Task 1"] -> quality-1
[agent wait [quality-1]]
  Quality reviewer: APPROVED — clean code, good tests

[bd close tau-a1 --reason "Implemented and reviewed"]

--- Task 2: Password hashing service ---
[bd update tau-a2 --status in_progress]

[agent spawn smart "Implement Task 2: Add password hashing service"] -> impl-2
[agent wait [impl-2]]
  Implementer: No questions, implemented, 5/5 tests passing.

[agent spawn review "Spec compliance for Task 2"] -> spec-2
[agent wait [spec-2]]
  Spec reviewer: Missing requirement — minimum password length validation (spec says 8 chars)

[agent spawn smart "Fix Task 2 spec gap: add minimum password length validation"] -> fix-2
[agent wait [fix-2]]
  Implementer: Added validation, 7/7 tests passing.

[agent send [spec-2] "Fixed: added minimum password length validation (8 chars). Please re-review."]
[agent wait [spec-2]]
  Spec reviewer: PASS
[agent close [spec-2]]

[agent spawn review "Code quality for Task 2"] -> quality-2
[agent wait [quality-2]]
  Quality reviewer: Important issue — magic number 8 should be extracted to MIN_PASSWORD_LENGTH

[agent spawn smart "Fix Task 2 quality issue: extract MIN_PASSWORD_LENGTH constant"] -> fix-2b
[agent wait [fix-2b]]
  Implementer: Extracted constant, 7/7 tests passing.

[agent send [quality-2] "Fixed: extracted MIN_PASSWORD_LENGTH constant. Please re-review."]
[agent wait [quality-2]]
  Quality reviewer: APPROVED
[agent close [quality-2]]

[bd close tau-a2 --reason "Implemented and reviewed"]

--- Task 3: Login handler ---
[bd update tau-a3 --status in_progress]

[agent spawn deep "Implement Task 3: Create login handler"] -> impl-3
[agent wait [impl-3]]
  Implementer: Implemented, 6/6 tests passing.

[agent spawn review "Spec compliance for Task 3"] -> spec-3
[agent wait [spec-3]]
  Spec reviewer: PASS

[agent spawn review "Code quality for Task 3"] -> quality-3
[agent wait [quality-3]]
  Quality reviewer: APPROVED

[bd close tau-a3 --reason "Implemented and reviewed"]

... (continue for all tasks)

[After all tasks: agent spawn review "Review full implementation for integration issues"] -> integration-1
[agent wait [integration-1]]
  Integration reviewer: PASS — handlers, domain types, and services align

[Run full gate: npm run gate]
[All checks passing]
[Done]
```

A few things to notice in the workflow:
- The implementer never reviews its own work
- Task 2 does not advance to quality review until spec review passes
- Re-reviews use `agent send` to the same reviewer, not a fresh `spawn` — the reviewer keeps context of what it originally found
- Reviewers are explicitly closed after they return PASS/APPROVED
- The task is not closed when the first implementation finishes; it closes only after both review loops pass
- Questions are answered before implementation continues
- Fixes are handled by focused follow-up agents, not by muddying the controller context

## Remember

```text
Fresh agent per task
Two-stage review every time
Spec compliance FIRST
Code quality SECOND
Never skip reviews
Reuse reviewers with send — don't spawn fresh for re-review
Catch issues early
```

**Quality is not an accident. It is the result of systematic process.**
