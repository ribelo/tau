# Agent Instructions

This project uses **bd (beads)** for issue tracking.
Run `bd prime` for workflow context, or install hooks (`bd hooks install`) for auto-injection.

## pi extension packaging (crucial)

- **tau is a bag of pi extensions**. Keep extension source code under `./extensions/<name>/` (package with `package.json` + `pi.extensions`).
- **Global pi config lives under `~/.pi`** and global extensions are discovered from **`~/.pi/agent/extensions/`**.
- To install/update tau extensions globally, symlink (or copy) `./extensions/*` into `~/.pi/agent/extensions/`.
- **Never create or use `./.pi/extensions/` inside this repo.** Project-local pi extension folders are not part of tau’s design.
- Use the helper installer:
  ```bash
  ./scripts/pi/install-extensions.sh
  ```

## parallel agent safety (crucial)

Multiple agents may work in the same checkout concurrently.

- **Do not run destructive git commands** outside the extension directory you are actively working on.
  - Never `git restore`, `git checkout`, `git reset`, `git clean`, or similar on other extensions’ files.
- If the repo is dirty due to someone else’s work and it blocks `bd sync`/`git pull`, **stop and ask** instead of trying to “fix” it.
  - Safe fallback: `bd sync --flush-only` (exports beads JSONL without git pull/rebase/push)
- It is always safe to run `bd` commands; `.beads/*` is designed for parallelism.

## Naming Conventions

- All tool names, tool labels, and command names that are visible to the user should be **lowercase** to match pi's built-in tools (`read`, `bash`, `edit`, `write`, etc.).
- If you need namespaces, use lowercase separators like `.` or `_` (e.g. `exa.web_search`, `exa.code_context`, `bd`).

## Extension logging

- Do not print startup banners or "extension loaded" messages (e.g. via `console.log`) from extensions.
- Rely on pi's own reporting/rendering system (tool renderers, custom messages, UI status) instead.

## Quick Reference

```bash
bd ready                                      # Find unblocked work
bd show <id>                                  # View issue details
bd create "Title" --type task --priority 2    # Create issue
bd update <id> --status in_progress            # Claim work
bd close <id>                                 # Complete work
bd sync                                       # Sync with git (run at session end)
bd prime                                      # Full workflow details
```

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds

