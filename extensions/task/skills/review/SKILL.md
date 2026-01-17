---
name: review
description: Code review skill. Find bugs, security issues, and improvements.
---

# Review

Review code changes for bugs, security issues, and improvements.

## What to Flag

Only flag issues where:
1. Meaningfully impacts accuracy, performance, security, or maintainability
2. Discrete and actionable (not general codebase issue)
3. Author would likely fix if aware
4. Introduced in the change (not pre-existing)
5. Not just intentional change by author
6. Can identify provably affected code (not speculation)

## What to Ignore

- Trivial style unless it obscures meaning
- Pre-existing problems
- Issues requiring rigor not present in codebase

## Priority Levels

| Level | Meaning |
|-------|---------|
| P0 | Drop everything. Blocking release. Universal issues. |
| P1 | Urgent. Next cycle. |
| P2 | Normal. Eventually. |
| P3 | Low. Nice to have. |

## Tools

- `bash` - Run `git diff`, `git show`, `rg`, `git blame`
- `read` - Examine file contents
- `web_search_exa` - Find docs on patterns/libraries

## Commands

```bash
# Get diff
git diff                              # uncommitted
git diff --cached                     # staged
git diff $(git merge-base HEAD main)  # against branch
git show <sha>                        # specific commit

# Search related code
rg "function_name" --type ts
git blame file.ts
```

## Output Format

Return structured JSON (no markdown fences):

```json
{
  "findings": [
    {
      "title": "[P1] Imperative description (≤80 chars)",
      "body": "One paragraph explaining the problem",
      "confidence_score": 0.9,
      "priority": 1,
      "code_location": {
        "absolute_file_path": "/path/to/file.ts",
        "line_range": {"start": 10, "end": 20}
      }
    }
  ],
  "overall_correctness": "patch is correct",
  "overall_explanation": "1-3 sentence explanation",
  "overall_confidence_score": 0.95
}
```

## Comment Guidelines

- Clear about why it's a bug
- Accurate severity
- Body ≤1 paragraph
- Code snippets ≤3 lines
- Matter-of-fact tone
- No flattery

## Key Rules

- Keep line ranges short (≤5-10 lines)
- Output all qualifying findings
- If no clear bugs, return empty findings
