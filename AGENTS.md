# Agent Instructions

This project uses **bd (beads)** for issue tracking.
Run `bd prime` for workflow context, or install hooks (`bd hooks install`) for auto-injection.

## pi extension packaging (crucial)

- **tau is a single pi extension with many features**. Keep extension source code under `./extensions/tau/` (`package.json` + `pi.extensions`).
- **Global pi config lives under `~/.pi`** and global extensions are discovered from **`~/.pi/agent/extensions/`**.
- To install/update tau globally, symlink (or copy) `./extensions/tau` into `~/.pi/agent/extensions/`.
- **Never create or use `./.pi/extensions/` inside this repo.** Project-local pi extension folders are not part of tau’s design.
- Use the helper installer:
  ```bash
  ./scripts/pi/install-extensions.sh
  ```
- **pi loads extension entrypoints via jiti** (https://github.com/unjs/jiti). This means TypeScript/ESM files are executed at runtime (no separate build step). Keep extension entrypoints compatible with jiti/Node ESM resolution (e.g. `type: "module"`, explicit `.js` import specifiers in TS where required).

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

## Writing Conventions

- Avoid contrastive phrasing that defines decisions by exclusion; state what the system does and the precise behavior/guarantee instead.

## Extension logging

- Do not print startup banners or "extension loaded" messages (e.g. via `console.log`) from extensions.
- Rely on pi's own reporting/rendering system (tool renderers, custom messages, UI status) instead.

## typescript hardening (crucial)

Goal: make `extensions/tau` as safe as rust.

- `any` is forbidden (including `as any`, `Record<string, any>`, and `unknown as any`).
  - Use `unknown` at boundaries (JSON, tool inputs) and narrow with type guards/validation.
  - Prefer explicit types over widening casts.
- Unused locals/params are allowed as warnings only (do not fail builds on unused).
  - Prefer `_name` for intentionally-unused values; lint reports warnings only.
- Keep strict options on in `extensions/tau/tsconfig.json` (no implicit any, exact optional types, no unchecked indexed access).

## Code Style: Final Form

Write code in its final form - clean, explicit, without fallbacks or migration paths.

- **No fallback logic**: When changing schemas or keys, remove the old code entirely. Don't support multiple variants.
- **No migrations**: Don't write upgrade scripts. Breaking changes should fail fast with clear errors.
- **Explicit over implicit**: Mandatory fields, strict parsing, no silent defaults. Fail if configuration is incomplete.
- **Delete, don't deprecate**: When refactoring, delete old code rather than keeping it working temporarily.
- **Invalid states are unrepresentable**: Design APIs and data structures so that invalid states cannot be expressed. When invalid data is encountered, stop immediately and report the error.

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

## Quality Gate

Run from `extensions/tau/`:
```bash
npm run gate
```

This runs: typecheck → lint → test

## Saying "Done" (chat / handoff rule)

Before the agent says "I'm done" (or hands off work as complete):

1. The agent MUST run `npm run gate` in `extensions/tau/`.
2. The agent MUST NOT present broken / failing code as finished work.
3. If `npm run gate` fails:
   - If the failure is caused by the agent's changes: fix it (or explicitly ask for approval to ship broken code).
   - If the failure seems pre-existing or unrelated: stop and ask the user before continuing, and record it (bd issue).

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
