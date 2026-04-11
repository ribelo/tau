---
name: backlog-planning
description: Plan and refine work into well-formed backlog items through grounded dialogue. Use when a request needs clarification, scope decisions, design direction, or a concrete definition of done before implementation.
---

# Planning with Backlog

## The Deal

Planning is for turning vague intent into executable work.

- Understand the problem
- Ground it in the codebase
- Ask focused questions only where needed
- Decide the approach
- Define observable success
- Encode that into backlog so implementation can proceed without guesswork

The goal is simple: by the time work is marked ready, an implementer should not need a clarification round to start.

## Separation of Concerns

- This skill is about planning and refinement
- The `$backlog` skill is about backlog mechanics, lifecycle, and durable task tracking

Use this skill to shape the work. Use `$backlog` to operate the system cleanly.

## Work Lifecycle

```text
idea → refinement → ready → work → done
```

### Idea

The user has intent but not a settled approach or definition of done yet.

Create an epic or task with the problem statement when it should be captured durably, even if details are still incomplete.

```text
backlog create "Auth system overhaul" --type epic --priority 2 --description "Current auth model is inconsistent and needs redesign."
```

### Refinement

Turn vague work into actionable backlog items:

- clarify the problem
- inspect the codebase
- decide scope and constraints
- choose the approach
- define acceptance criteria
- decompose into tasks if needed

### Ready

A ready item has enough context for implementation:

- description explains the problem and why it matters
- design captures the chosen approach and key tradeoffs
- acceptance criteria define what must be true when complete
- dependencies and parent-child structure are explicit

### Done

The implementation meets the acceptance criteria and the backlog item can be closed with a concrete reason.

## Planning Steps

### 1. Understand the Problem

Start with the user problem, not the solution.

Figure out:

- what is broken, missing, or desired
- who or what is affected
- why it matters now
- what constraints already exist

Do not jump straight into implementation details.

### 2. Ground in the Codebase

Before asking the user, do the work you can do yourself:

- search for the relevant area
- read the existing implementation and adjacent patterns
- inspect current APIs, schemas, commands, or docs
- run the relevant command or test when behavior needs confirmation

Questions should come after investigation, not instead of it.

### 3. Ask Grounded Questions

When you need clarification, make it specific and informed.

Bad:

- "Where is the auth code?"
- "How should this work?"

Good:

- "I found auth flow in `src/auth/` and current API middleware in `src/http/auth.ts`. Should the new endpoint reuse that middleware or deliberately split browser and API validation?"
- "Current backlog items treat worker sandboxing as a security issue. Should this slice stay focused on enforcement only, or also include UI surfacing for denied tool calls?"

Pattern:

"I found X. Should we do Y or Z?"

### 4. Decide the Approach

Planning must choose how the work will be solved.

Capture:

- architecture or pattern to follow
- boundaries of the slice
- tradeoffs accepted for this iteration
- what is explicitly out of scope

This becomes the backlog item's `design`.

### 5. Define Done

Define success as observable outcomes, not implementation steps.

This becomes the backlog item's acceptance criteria.

Good acceptance criteria answer:

- what behavior exists when the work is complete
- what a reviewer or implementer can verify
- what users or downstream systems will observe

Bad acceptance criteria are really design notes in disguise.

## Before Creating or Updating Items

### Check for Existing Work

Search first. Do not create duplicates.

```text
backlog search "auth"
backlog list --type epic
backlog list --type task
```

If an item already exists, prefer updating or linking it.

### Find or Create the Epic

Most substantial work belongs under an epic or other parent container.

```text
backlog list --type epic
backlog show <epic-id>
```

If no fitting epic exists, create one for the user-visible goal, then link child work with `parent-child`.

### Model Dependencies Explicitly

If work truly depends on other work, add the dependency edge.

```text
backlog dep add <issue-id> <depends-on-id> --type blocks
```

Use relationships, not prose, to model execution order.

## Creating Well-Formed Items

Example:

```text
backlog create "Add worker sandbox enforcement" \
  --type task \
  --priority 1 \
  --description "Worker agents currently bypass tau sandbox enforcement because worker sessions do not inherit tau's tool restrictions." \
  --design "Enforce sandbox restrictions in worker tool execution, keep policy inheritance explicit, and fail fast when a requested tool is outside the effective allowlist." \
  --acceptance-criteria "Worker agents can only execute tools allowed by the effective sandbox policy, denied calls fail visibly, and an automated regression test covers the restricted path."
```

If the task belongs under a parent item:

```text
backlog dep add <child-id> <epic-id> --type parent-child
```

## Field Guidance

### Description

Use `description` for:

- the problem
- relevant context
- why the work matters
- user impact or system impact

This is the stable problem statement.

### Design

Use `design` for:

- chosen approach
- architecture or implementation shape
- tradeoffs and constraints
- what patterns to mirror

This can evolve if planning evolves.

Example:

"Add a dedicated execution schema layer, keep `/mode` as the user-facing command, and resolve session behavior through a shared execution-profile service rather than scattered prompt-mode state."

### Acceptance

Use acceptance criteria for:

- observable outcomes
- verifiable completion conditions
- externally meaningful behavior

Example:

"Switching mode updates the active execution profile used by the session, Ralph iterations inherit the intended profile, and spawned agents respect the effective tool policy."

Test:

If the statement would still be valid under a different implementation, it is probably acceptance criteria. If it only describes one implementation approach, it belongs in design.

### Comments

Use comments for durable planning notes that matter later:

- decisions made after the item was created
- discovered edge cases
- handoff notes
- narrowed scope or follow-up rationale

Do not overload comments with the core contract if `description`, `design`, or acceptance should be updated instead.

## Decomposition Rules

### Use an Epic When

- the goal spans multiple deliverables
- the user asked for a broad feature or migration
- several tasks share one user-visible outcome

### Split into Tasks When

- deliverables can be completed independently
- dependencies are real and worth modeling
- different files or subsystems can be verified separately
- a single item would otherwise hide too much complexity

### Keep One Item When

- the work is a small, coherent slice
- decomposition would add bookkeeping without clarity

## Task Types

| Type | Use for | Planning depth |
|------|---------|----------------|
| `epic` | Multi-item goal or initiative | vision and boundaries |
| `feature` | New user-visible capability | full planning |
| `bug` | Broken behavior | repro, expected vs actual |
| `task` | Concrete implementation slice | focused plan |
| `chore` | Maintenance or housekeeping | minimal |

### Bug Planning

For bugs, capture the repro clearly in `description`:

- steps to reproduce
- expected behavior
- actual behavior
- evidence when available

Example:

```text
backlog create "Worker sandbox policy ignored" \
  --type bug \
  --priority 1 \
  --description "Steps: 1. Spawn a worker agent from a restricted session. 2. Call a tool that should be denied. Expected: call is blocked by inherited sandbox policy. Actual: worker executes the tool without restriction."
```

## Priority Guidance

| Level | Meaning | Typical action |
|-------|---------|----------------|
| P0 | Production down or severe incident | do immediately |
| P1 | Urgent, user-impacting, or security-critical | next up |
| P2 | Normal planned work | default |
| P3 | Useful but not urgent | fit in later |
| P4 | Someday or speculative | keep in backlog |

Set priority during planning instead of leaving urgency implicit.

## Planning Checklist

- [ ] Problem is understood
- [ ] Relevant code and patterns were inspected
- [ ] Questions, if any, are grounded in findings
- [ ] Scope and approach are decided
- [ ] Acceptance criteria define real completion
- [ ] Existing epic or related work was checked
- [ ] Dependencies are modeled explicitly
- [ ] Priority is set intentionally

If you cannot define done, the work is not planned yet.

## Reference

For backlog mechanics, lifecycle usage, dependencies, and durable task hygiene, use the `$backlog` skill.
