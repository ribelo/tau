---
name: ast-grep
description: AST-aware code search and transformation using ast-grep (sg). Use for structural code changes that respect syntax.
---

# ast-grep (sg)

AST-aware search and transformation. Matches code structure, not text.

## When to Use

- Structural search respecting syntax
- Safe refactoring (rename, wrap, transform)
- Pattern-based code migration
- Finding code by structure, not text

## Concepts

### Patterns

Patterns match AST structure like regex matches text:

```bash
# Pattern matches actual code
sg --pattern 'obj.val && obj.val()' --lang ts
# Matches: obj.val && obj.val()
# Matches: obj.val  &&  obj.val()  (whitespace ignored)
```

### Meta Variables

`$VAR` matches any single AST node (like regex `.`):

```bash
# $PROP matches any expression
sg --pattern '$PROP && $PROP()' --lang ts
# Matches: foo.bar && foo.bar()
# Matches: x && x()
```

### Multi Meta Variables

`$$$` matches zero or more nodes:

```bash
# Match any console.log call
sg --pattern 'console.log($$$ARGS)' --lang ts
# Matches: console.log()
# Matches: console.log('a')
# Matches: console.log('a', b, c)
```

### Capture Groups

Same meta variable name = same content:

```bash
# Find duplicate expressions
sg --pattern '$A == $A' --lang ts
# Matches: x == x
# Matches: 1+1 == 1+1
# NOT: a == b
```

## Commands

### Search

```bash
# Find pattern
sg --pattern 'console.log($$$)' --lang ts

# Count matches
sg --pattern 'TODO' --lang ts --json | jq length
```

### Rewrite

```bash
# Interactive rewrite
sg --pattern '$PROP && $PROP()' \
   --rewrite '$PROP?.()' \
   --lang ts \
   --interactive

# Apply all (dangerous)
sg --pattern '$OLD($A)' \
   --rewrite '$NEW($A)' \
   --lang ts \
   -U  # update in place
```

## Common Patterns

### Rename function

```bash
sg --pattern 'oldFunc($$$ARGS)' \
   --rewrite 'newFunc($$$ARGS)' \
   --lang ts -U
```

### Optional chaining

```bash
sg --pattern '$A && $A.$B' \
   --rewrite '$A?.$B' \
   --lang ts -U
```

### Wrap in function

```bash
sg --pattern 'dangerous($A)' \
   --rewrite 'safe(() => dangerous($A))' \
   --lang ts -U
```

### Add argument

```bash
sg --pattern 'doThing($A)' \
   --rewrite 'doThing($A, {})' \
   --lang ts -U
```

### Update import

```bash
sg --pattern 'import { $$$IMPORTS } from "old-pkg"' \
   --rewrite 'import { $$$IMPORTS } from "new-pkg"' \
   --lang ts -U
```

## Workflow

1. **Search first**: Understand scope
   ```bash
   sg --pattern 'oldName' --lang ts
   ```

2. **Dry run**: Preview changes
   ```bash
   sg --pattern 'old' --rewrite 'new' --lang ts
   # Shows diffs without applying
   ```

3. **Apply**: Make changes
   ```bash
   sg --pattern 'old' --rewrite 'new' --lang ts -U
   ```

4. **Verify**: Build and test
   ```bash
   npm run build && npm test
   ```

## Tips

- Use single quotes for patterns (shell expands `$` in double quotes)
- `--interactive` for safety on large changes
- `-U` updates files in place
- Patterns must be valid parseable code
- Use ast-grep playground to test patterns
