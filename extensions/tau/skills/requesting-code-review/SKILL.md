---
name: requesting-code-review
description: Iterative code review loop with a persistent reviewer agent. Reviews repeat until no findings remain. Agent validates each finding by writing a RED test before fixing. Use when completing tasks, implementing major features, or before merging.
---

# Requesting Code Review

## Overview

Dispatch a single reviewer agent and keep the conversation going until there are zero findings. Validate every claim the reviewer makes — write a failing test (RED) before fixing anything.

**Core principle:** Trust but verify. A reviewer finding that cannot be reproduced with a RED test is not a real finding.

## When to Request Review

**Mandatory:**
- After completing a major feature
- Before merge to main
- After bug fixes touching critical paths

**Optional but valuable:**
- When stuck (fresh perspective)
- Before refactoring (baseline check)
- After complex logic implementation

## The Review Loop

### Step 0: Self-Check

Before dispatching a reviewer, run the project gate:

```bash
npm run gate    # or the project's equivalent
rg -n "console\.log|debugger" src test    # debug leftovers
```

Fix anything obvious. Do not waste reviewer time on things you can catch yourself.

### Step 1: Spawn One Reviewer

Spawn a single review agent. This agent stays alive for the entire review loop — you reuse it with `send` for follow-up rounds.

```
agent spawn review "Review uncommitted changes for correctness and quality

WHAT WAS IMPLEMENTED:
[Brief description]

FILES CHANGED:
[List files]

Focus on: correctness, edge cases, error handling, security, test coverage.

OUTPUT FORMAT:
- P0 (critical): blocks merge
- P1 (important): should fix
- P2 (minor): nice to have
- Verdict: APPROVE / REQUEST_CHANGES"
```

Save the returned `agent_id` — you will reuse it.

### Step 2: Wait and Read Findings

```
agent wait [reviewer_id]
```

Read the findings carefully. Categorize:
- **P0 (critical):** Must fix. Security holes, broken behavior, data loss.
- **P1 (important):** Should fix. Missing edge cases, poor error handling.
- **P2 (minor):** Optional. Style, naming, docs.

If verdict is **APPROVE** with zero P0/P1 findings → done. Close the reviewer.

### Step 3: Validate Each Finding with a RED Test

For every P0 and P1 finding, before writing any fix:

1. **Write a test that exposes the claimed bug or missing behavior.**
2. **Run the test.** It must fail (RED).
3. If the test **passes** → the reviewer's claim is wrong. Note it as invalid.
4. If the test **fails** → confirmed. Proceed to fix.

This follows the test-driven-development skill's RED-GREEN-REFACTOR cycle:
- **RED:** Test fails, proving the finding is real.
- **GREEN:** Write minimal fix to pass the test.
- **REFACTOR:** Clean up if needed.

```bash
# RED — verify the finding is real
vitest run test/feature.test.ts -t "edge case reviewer found"
# Must FAIL

# GREEN — fix it
# ... write the fix ...
vitest run test/feature.test.ts -t "edge case reviewer found"
# Must PASS

# Full suite — no regressions
vitest run
```

### Step 4: Push Back on Invalid Findings

If a test passes immediately (finding is not reproducible):
- The reviewer was wrong. Do not fix a non-bug.
- Note it with evidence: "Wrote test X, it passes — finding is not valid."
- Include this in the follow-up message to the reviewer.

### Step 5: Send Follow-Up Review

After fixing all valid P0/P1 findings, send a follow-up to the **same reviewer agent**:

```
agent send [reviewer_id] "Follow-up review — fixes applied

CHANGES SINCE LAST REVIEW:
- Fixed [finding 1]: added bounds check in parse(), test in test/parse.test.ts
- Fixed [finding 2]: handle empty input in validate(), test in test/validate.test.ts
- INVALID [finding 3]: wrote test proving behavior is correct (test/foo.test.ts:42)

Please re-review. Focus on whether the fixes are correct and check for new issues introduced by the changes.

Same output format: P0/P1/P2 + Verdict."
```

Then `agent wait [reviewer_id]` again.

### Step 6: Repeat Until APPROVE

Continue the loop:
1. Read findings
2. Validate with RED tests
3. Fix valid findings
4. Send follow-up
5. Wait for re-review

**Exit conditions:**
- Verdict is APPROVE with zero P0/P1 findings.
- All remaining findings are P2 (minor) and you choose to defer them.

### Step 7: Close Reviewer

```
agent close [reviewer_id]
```

## Decision Tree

```
spawn reviewer → wait for findings
  ↓
APPROVE + no P0/P1 → close reviewer → done
  ↓
REQUEST_CHANGES →
  for each P0/P1 finding:
    write RED test →
      test FAILS → fix (GREEN) → record fix
      test PASSES → mark finding invalid → record evidence
  ↓
send follow-up to same reviewer → wait
  ↓
(repeat until APPROVE)
```

## Rules

1. **One reviewer agent for the entire loop.** Spawn once, send follow-ups. Do not spawn new reviewers each round.
2. **Every P0/P1 finding gets a RED test.** No exceptions. If you cannot write a test for it, ask the reviewer to clarify the exact failure scenario.
3. **Invalid findings are reported back.** Do not silently ignore them. Tell the reviewer what you tested and why the finding does not hold.
4. **P2 findings are optional.** Fix them if quick, defer otherwise.
5. **The loop ends on APPROVE.** Not on "I think it's fine." The reviewer must explicitly approve.
6. **Run the full test suite after each fix round.** No regressions allowed.

## Integration with TDD

The RED test step IS test-driven development applied to review findings:
- The reviewer's finding is the "requirement."
- The RED test proves the requirement is unmet.
- The GREEN fix satisfies it.
- The test stays as a regression guard.

Review findings that survive RED test validation become permanent tests in the codebase. This is how reviews improve the test suite over time.

## Anti-Patterns

- **Blindly trusting the reviewer:** Fixing things without verifying they are actually broken. Wastes time and introduces unnecessary changes.
- **Spawning a new reviewer each round:** Loses context from previous rounds. The reviewer cannot see what was already discussed.
- **Skipping RED tests for "obvious" findings:** Obvious bugs that cannot be reproduced with a test are not bugs.
- **Arguing without evidence:** If you disagree with a finding, write the test. The test result is the evidence.
- **Fixing P2s before P0s:** Priority order matters. Critical issues first.
