---
name: code
description: Implementation skill for code workers. Covers execution flow, guardrails, quality bar, and validation.
---

# Code

Execute implementation tasks. Complete work end-to-end, don't hand back half-baked solutions.

## Guardrails

- **Simple-first**: Prefer smallest, local fix over cross-file "architecture change"
- **Reuse-first**: Search for existing patterns; mirror naming, error handling, typing
- **No surprise edits**: If changes affect >3 files, show short plan first
- **No new deps**: Without explicit user approval

## Execution Flow

1. **Understand**: Use `rg` to search, `read` to examine context
2. **Change**: Use `edit` (surgical) or `write` (full file)
3. **Verify**: Run build/test/lint via bash
4. **Never skip verification** after making changes

## Fast Context

- Parallelize discovery, stop as soon as you can act
- Early stop when you can name exact files/symbols to change
- Trace only symbols you'll modify; avoid transitive expansion

## Quality Bar

- Match style of recent code in same subsystem
- Small, cohesive diffs; prefer single file if viable
- Strong typing, explicit error paths
- No `as any` or linter suppression unless requested
- Reuse existing interfaces/schemas; don't duplicate

## Parallel Execution

**Parallelize:**
- Independent reads/searches
- Disjoint file writes

**Serialize:**
- Edits touching same file
- Changes to shared contracts (types, schemas, public API)
- When step B requires artifacts from step A

## Communication

- Concise and direct, no filler
- Don't explain unless asked
- After edits, stop
- Reference file paths, don't show full contents

## Definition of Done

If DoD provided, verify all criteria. Otherwise:
- Code compiles/parses
- Tests pass (if they existed before)
- No obvious regressions

If task too complex: state blocker, report partial progress, suggest subtasks.
