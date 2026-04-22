---
name: ralph-wiggum
description: Long-running iterative development loops with pacing control and verifiable progress. Use when tasks require multiple iterations, many discrete steps, or periodic reflection with clear checkpoints; avoid for simple one-shot tasks or quick fixes.
---

# Ralph Wiggum - Long-Running Development Loops

## Creating a Task File

Write the task file directly at `.pi/loops/tasks/<name>.md` using `write` or `edit`.

Pick a concise lowercase hyphenated name that fits naturally in `/ralph start <name>`.

If the target corresponds to a backlog item, inspect it first with `backlog show <id>` and synthesize the task from that issue. Use the backlog id as the file name (e.g. `.pi/loops/tasks/foo-31z.md`).

### Task File Template

```markdown
# Task Title

Brief description of the work.

## Goals
- Goal 1
- Goal 2

## Checklist
- [ ] Item 1
- [ ] Item 2

## Verification
- Commands, outputs, or file paths that prove the work is done

## Notes
(Update with progress, decisions, blockers as you work)
```

### Structure Rules

- **Title and brief summary** at the top.
- **Goals** — concrete outcomes.
- **Checklist** — discrete, verifiable items. Each item stands alone.
- **Verification** — commands to run, files to check, outputs to capture.
- **Notes** — assumptions, decisions, progress updates during the loop.

After writing the file, tell the user the path and recommend starting with `/ralph start <name>`.

## Starting and Running Loops

The `/ralph` command manages loop lifecycle. The agent does not start loops — the user does.

### User Commands

| Command | Description |
|:--------|:------------|
| `/ralph start <name\|path> [options]` | Start a new loop |
| `/ralph pause` | Pause current loop (keep resumable) |
| `/ralph stop` | End active loop (agent must be idle) |
| `/ralph resume <name> [options]` | Resume a paused or completed loop |
| `/ralph status` | Show all loops |
| `/ralph list --archived` | Show archived loops |
| `/ralph archive <name>` | Move loop to archive |
| `/ralph clean [--all]` | Clean completed loops |
| `/ralph cancel <name>` | Delete loop state |
| `/ralph nuke [--yes]` | Delete all Ralph loop data |

### Start Options

| Option | Description |
|:-------|:------------|
| `--max-iterations N` | Stop after N iterations (default 50) |
| `--items-per-iteration N` | Suggest N items per turn (prompt hint) |
| `--reflect-every N` | Reflect every N iterations |

Press ESC to interrupt streaming. Run `/ralph pause` to keep the loop resumable, or `/ralph stop` when idle to end it.

## Loop Behavior During Iterations

1. Read the task file and work on the next unchecked item(s).
2. Update the task file as you progress (check off items, add notes, record verification evidence).
3. Call `ralph_continue` to proceed to the next iteration.
4. Call `ralph_finish` with a short completion message when all work is done.
5. End each iteration with exactly one Ralph loop tool — never end with free text alone.

## Best Practices

1. Write a clear checklist with discrete items — each should be independently verifiable.
2. Update checklist and notes every iteration.
3. Capture verification evidence (commands run, file paths, test output) for completed items.
4. Reflect when stuck to reassess approach.
5. Keep iterations focused — respect `items-per-iteration` when set.
