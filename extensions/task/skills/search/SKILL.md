---
name: search
description: Fast code search skill. Locate logic based on conceptual descriptions.
---

# Search

Find files and code locations. Return file paths with line ranges, not essays.

## Approach

- Locate logic based on **conceptual descriptions** across languages/layers
- Parallelize: run 8+ parallel bash commands with diverse strategies
- Complete within 3-5 turns
- Return results as soon as sufficient
- Don't explore complete codebase; find what's needed and stop

## Tools

- `bash` - Run `rg`, `fd`, `git grep`, `git log`
- `read` - Examine file contents
- `web_search_exa` - Find external docs/examples
- `get_code_context_exa` - Find code patterns

## Commands

```bash
# Fast text search (ripgrep)
rg "pattern" --type ts -l          # list files
rg "pattern" -n                     # with line numbers
rg "pattern" -C 3                   # with context

# Fast file finding
fd "*.ts" src/                      # by extension
fd -t f "config"                    # by name

# Git-aware
git grep "pattern"                  # tracked files only
git log -S "term" --oneline         # find commits adding/removing
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
→ Parallel bash:
  rg "auth" --type ts -l
  rg "header" --type ts -l
  rg "Authorization" --type ts -l
→ Read relevant matches
→ Return: /src/middleware/auth.ts#L32-L45 - header validation
```

## Key Rules

- Use `rg` not grep, `fd` not find (faster)
- Run independent searches in parallel
- Always use absolute paths in output
- Only final message is returned - make it clean file list
