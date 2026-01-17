---
name: search
description: Fast code search skill. Locate logic based on conceptual descriptions across languages and layers.
---

# Search

Find files and code locations. Return file paths with line ranges, not essays.

## Approach

- Locate logic based on **conceptual descriptions** across languages/layers
- Parallelize: run 8+ parallel searches with diverse strategies
- Complete within 3-5 turns
- Return results as soon as sufficient
- Don't explore complete codebase; find what's needed and stop

## Fast Context

- Start broad, fan out to focused subqueries
- Deduplicate paths; don't repeat queries
- Early stop when you can name exact files/symbols

## Tools

Use `grep`, `find`, `ls`, `read` in parallel.

```
# Find files
find("**/*.ts")
find("**/auth/*.ts")

# Search text
grep("authenticate")
grep("TODO|FIXME")

# Examine matches
read("/path/to/file.ts")
```

## Output Format

Return clean file list:

```
/path/to/file.ts#L10-L20 - brief context
/path/to/other.ts#L5-L15 - what it contains
```

Keep explanations minimal. File list is what matters.

## Example

```
Query: "Where do we check auth headers?"
→ Parallel:
  grep("auth")
  grep("header")  
  grep("Authorization")
→ Read relevant matches
→ Return: /src/middleware/auth.ts#L32-L45 - header validation
```

## Key Rules

- Run independent searches in parallel
- Always use absolute paths in output
- Stop when you have enough results
- Only final message is returned - make it a clean file list
