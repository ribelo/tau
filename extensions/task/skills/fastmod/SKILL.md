---
name: fastmod
description: Fast regex-based find and replace across files. Use for text-level refactoring when AST-awareness not needed.
---

# fastmod

Fast interactive find-and-replace across files. Text-based, not AST-aware.

## When to Use

- Simple text/regex replacements
- String literal changes
- Import path updates
- When ast-grep is overkill

## When NOT to Use

- Structural code changes (use ast-grep)
- Syntax-aware transformations (use ast-grep)
- Changes that could match inside strings/comments unintentionally

## Syntax

Uses Rust regex syntax (not Python):
- `${1}` for capture groups (not `\1`)
- `$$` for literal `$`
- Single quotes recommended (shell expands `$` in double quotes)

## Commands

### Basic replace

```bash
# Interactive mode (default)
fastmod 'oldName' 'newName' --extensions ts,tsx

# Auto-accept all
fastmod 'oldName' 'newName' --extensions ts,tsx --accept-all

# Preview only
fastmod 'oldName' 'newName' --extensions ts,tsx --print-only
```

### With regex

```bash
# Capture groups use ${N}
fastmod 'import .* from "old-pkg"' 'import { x } from "new-pkg"' --extensions ts

# More complex capture
fastmod '<b>(.*?)</b>' '<strong>${1}</strong>' --extensions html
```

### Directory targeting

```bash
# Specific directory
fastmod 'old' 'new' --extensions ts src/

# Multiple directories
fastmod 'old' 'new' --extensions ts src/ lib/
```

## Options

| Flag | Description |
|------|-------------|
| `--extensions ts,tsx` | Filter by extension |
| `--accept-all` | Apply all without prompting |
| `--print-only` | Preview without changing |
| `-m` | Multiline mode |
| `-i` | Case insensitive |
| `-w` | Match whole words |
| `-d DIR` | Search directory |

## Common Patterns

### Rename variable/function

```bash
fastmod 'oldName' 'newName' --extensions ts --accept-all
```

### Update import path

```bash
fastmod 'from "old-pkg"' 'from "new-pkg"' --extensions ts --accept-all
```

### Update string literal

```bash
fastmod '"old-value"' '"new-value"' --extensions ts --accept-all
```

### Fix typo everywhere

```bash
fastmod 'recieve' 'receive' --extensions ts,tsx,md --accept-all
```

### Update URL

```bash
fastmod 'api.old.com' 'api.new.com' --extensions ts,json --accept-all
```

## Workflow

1. **Count matches first**
   ```bash
   rg 'oldName' --type ts -l | wc -l
   ```

2. **Preview changes**
   ```bash
   fastmod 'oldName' 'newName' --extensions ts --print-only
   ```

3. **Interactive review** (for important changes)
   ```bash
   fastmod 'oldName' 'newName' --extensions ts
   # y=accept, n=reject, e=edit
   ```

4. **Bulk apply** (when confident)
   ```bash
   fastmod 'oldName' 'newName' --extensions ts --accept-all
   ```

5. **Verify**
   ```bash
   npm run build && npm test
   ```

## Tips

- Use `rg` first to understand scope
- Use single quotes for patterns
- `--extensions` prevents accidental changes to wrong files
- Interactive mode is default for safety
- Respects `.gitignore` automatically
