---
name: writing-plans
description: Use when you have a spec or requirements for a multi-step task. Creates comprehensive implementation plans with bite-sized tasks, exact file paths, and complete code examples. Upstream input to subagent-driven-development.
---

# Writing Implementation Plans

## Overview

Write comprehensive implementation plans assuming the implementer has zero context for the codebase and questionable taste. Document everything they need: which files to touch, complete code, testing commands, docs to check, how to verify. Give them bite-sized tasks. DRY. YAGNI. TDD. Frequent commits.

Assume the implementer is a skilled developer but knows almost nothing about the toolset or problem domain. Assume they don't know good test design very well.

**Core principle:** A good plan makes implementation obvious. If someone has to guess, the plan is incomplete.

## When to Use

**Always use before:**
- Implementing multi-step features
- Breaking down complex requirements
- Delegating to agents via subagent-driven-development

**Don't skip when:**
- Feature seems simple (assumptions cause bugs)
- You plan to implement it yourself (future you needs guidance)
- Working alone (documentation matters)

## Bite-Sized Task Granularity

**Each task = 2-5 minutes of focused work.**

Every step is one action:
- "Write the failing test" — step
- "Run it to make sure it fails" — step
- "Implement the minimal code to make the test pass" — step
- "Run the tests and make sure they pass" — step
- "Commit" — step

**Too big:**
```markdown
### Task 1: Build authentication system
[50 lines of code across 5 files]
```

**Right size:**
```markdown
### Task 1: Create User schema with email field
[10 lines, 1 file]

### Task 2: Add passwordHash field to User
[8 lines, 1 file]

### Task 3: Create password hashing service
[15 lines, 1 file]
```

## Plan Document Structure

### Header (Required)

Every plan MUST start with:

```markdown
# [Feature Name] Implementation Plan

> **Execution:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** [One sentence describing what this builds]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key technologies/libraries]

---
```

### Task Structure

Each task follows this format:

````markdown
### Task N: [Descriptive Name]

**Objective:** What this task accomplishes (one sentence)

**Files:**
- Create: `exact/path/to/new-file.ts`
- Modify: `exact/path/to/existing.ts:45-67` (line numbers if known)
- Test: `test/path/to/new-file.test.ts`

**Step 1: Write failing test**

```typescript
import { describe, it, expect } from "vitest";
import { createUser } from "../src/domain/user.js";

describe("createUser", () => {
  it("creates a user with email and hashed password", () => {
    const user = createUser("alice@example.com", "hashed123");
    expect(user.email).toBe("alice@example.com");
    expect(user.passwordHash).toBe("hashed123");
  });
});
```

**Step 2: Run test to verify failure**

Run: `npm test -- test/domain/user.test.ts`
Expected: FAIL — "createUser is not a function"

**Step 3: Write minimal implementation**

```typescript
export interface User {
  readonly email: string;
  readonly passwordHash: string;
}

export const createUser = (email: string, passwordHash: string): User => ({
  email,
  passwordHash,
});
```

**Step 4: Run test to verify pass**

Run: `npm test -- test/domain/user.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add test/domain/user.test.ts src/domain/user.ts
git commit -m "feat: add User schema with email and passwordHash"
```
````

## Writing Process

### Step 1: Understand Requirements

Read and understand:
- Feature requirements
- Design documents or user description
- Acceptance criteria
- Constraints

### Step 2: Explore the Codebase

Use pi tools to understand the project:

```bash
# Understand project structure
find src -type f -name "*.ts" | head -30

# Look at similar features
rg "similar_pattern" src/ --type ts -l

# Check existing tests
find test -type f -name "*.test.ts" | head -20

# Read key files
read src/app.ts
read src/domain/existing-model.ts
```

### Step 3: Design Approach

Decide:
- Architecture pattern
- File organization
- Dependencies needed
- Testing strategy

### Step 4: Write Tasks

Create tasks in order:
1. Setup/infrastructure
2. Core functionality (TDD for each)
3. Edge cases
4. Integration
5. Cleanup/documentation

### Step 5: Add Complete Details

For each task, include:
- **Exact file paths** (not "the config file" but `src/config/settings.ts`)
- **Complete code examples** (not "add validation" but the actual code)
- **Exact commands** with expected output
- **Verification steps** that prove the task works

### Step 6: Review the Plan

Check:
- [ ] Tasks are sequential and logical
- [ ] Each task is bite-sized (2-5 min)
- [ ] File paths are exact
- [ ] Code examples are complete (copy-pasteable)
- [ ] Commands are exact with expected output
- [ ] No missing context
- [ ] DRY, YAGNI, TDD principles applied

### Step 7: Save the Plan and Create Beads Tasks

Save the plan to a predictable location in the project, then create beads tasks so progress is tracked across sessions and agents:

```bash
# Save the plan
mkdir -p docs/plans
write docs/plans/2026-03-27-auth-feature.md

# Create beads tasks matching the plan
bd create "Create User schema with email field" --type task --priority 2 --description "Plan: docs/plans/2026-03-27-auth-feature.md — Task 1"
bd create "Add passwordHash field to User" --type task --priority 2 --description "Plan: docs/plans/2026-03-27-auth-feature.md — Task 2"
bd create "Create password hashing service" --type task --priority 2 --description "Plan: docs/plans/2026-03-27-auth-feature.md — Task 3"

# Commit the plan itself
git add docs/plans/
git commit -m "docs: add implementation plan for auth feature"
```

Creating beads tasks is important because:
- Progress survives context compaction and session handoffs
- Agents dispatched via subagent-driven-development can reference task IDs
- The orchestrator can check `bd ready` to find unblocked work
- Dependencies between tasks can be expressed with `--blocked-by`

## Principles

### DRY (Don't Repeat Yourself)

**Bad:** Copy-paste validation in 3 places
**Good:** Extract validation function, use everywhere

### YAGNI (You Aren't Gonna Need It)

**Bad:** Add "flexibility" for future requirements
**Good:** Implement only what's needed now

```typescript
// Bad — YAGNI violation
interface User {
  readonly email: string;
  readonly passwordHash: string;
  readonly preferences: Record<string, unknown>;  // Not needed yet!
  readonly metadata: Record<string, unknown>;      // Not needed yet!
}

// Good — YAGNI
interface User {
  readonly email: string;
  readonly passwordHash: string;
}
```

### TDD (Test-Driven Development)

Every task that produces code should include the full TDD cycle:
1. Write failing test
2. Run to verify failure
3. Write minimal code
4. Run to verify pass

### Frequent Commits

Commit after every task:
```bash
git add [files]
git commit -m "type: description"
```

Use conventional commit prefixes: `feat:`, `fix:`, `test:`, `refactor:`, `docs:`, `chore:`.

## Common Mistakes

### Vague Tasks

**Bad:** "Add authentication"
**Good:** "Create User schema with email and passwordHash fields"

### Incomplete Code

**Bad:** "Step 1: Add validation function"
**Good:** "Step 1: Add validation function" followed by the complete function code

### Missing Verification

**Bad:** "Step 3: Test it works"
**Good:** "Step 3: Run `npm test -- test/auth.test.ts`, expected: 3 passed"

### Missing File Paths

**Bad:** "Create the model file"
**Good:** "Create: `src/domain/user.ts`"

### No Beads Tasks

**Bad:** Save the plan and start working from memory
**Good:** Create beads tasks matching each plan task so progress is tracked, agents can reference task IDs, and work survives session boundaries

### Skipping Codebase Exploration

**Bad:** Write the plan from assumptions about the project structure
**Good:** Read existing files, check conventions, look at similar features before writing any tasks

## Execution Handoff

After saving the plan and creating beads tasks, offer the execution approach:

**"Plan complete and saved. Beads tasks created. Ready to execute using subagent-driven-development — I'll dispatch a fresh agent per task with two-stage review (spec compliance then code quality). Shall I proceed?"**

When executing, use the `subagent-driven-development` skill:
- Fresh agent per task with full context provided inline
- Spec compliance review after each task
- Code quality review after spec passes
- Proceed only when both reviews approve
- Close beads task after both reviews pass

## Integration with Other Skills

### With subagent-driven-development

This skill creates plans. subagent-driven-development executes them:
1. User requirements → writing-plans → implementation plan + beads tasks
2. Implementation plan → subagent-driven-development → working code

### With beads

Plans produce beads tasks. Beads tracks progress:
- Each plan task maps to a beads issue
- Dependencies between tasks use `--blocked-by`
- `bd ready` shows what can be worked on next
- Closing a beads task means both review stages passed

## Remember

```
Bite-sized tasks (2-5 min each)
Exact file paths
Complete code (copy-pasteable)
Exact commands with expected output
Verification steps
DRY, YAGNI, TDD
Frequent commits
Create beads tasks
```

**A good plan makes implementation obvious.**
