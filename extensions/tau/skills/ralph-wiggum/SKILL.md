---
name: ralph-wiggum
description: Long-running iterative development loops with pacing control and verifiable progress. Use when tasks require multiple iterations, many discrete steps, or periodic reflection with clear checkpoints; avoid for simple one-shot tasks or quick fixes.
---

# Ralph Wiggum - Long-Running Development Loops

Use the `ralph_create` tool to create a loop task:

```
ralph_create({
  name: "loop-name",
  taskContent: "# Task\n\n## Goals\n- Goal 1\n\n## Checklist\n- [ ] Item 1\n- [ ] Item 2",
  maxIterations: 50,        // Default: 50
  itemsPerIteration: 3,     // Optional: suggest N items per turn
  reflectEvery: 10          // Optional: reflect every N iterations
})
```

## Loop Behavior

1. **Write the task file**: The `ralph_create` tool creates `.pi/ralph/tasks/<name>.md` with the provided task content.
2. Start the fresh-session loop with `/ralph start <name>`.
3. Work on the task and update the file each iteration.
4. Record verification evidence (commands run, file paths, outputs) in the task file.
5. Call `ralph_done` to proceed to the next iteration.
6. Output `<promise>COMPLETE</promise>` when finished.
7. Stop when complete or when max iterations is reached (default 50).

## User Commands

- `/ralph create <request|path|backlog-id>` - Ask the current model to draft a task file.
- `/ralph start <name>` - Start a new loop.
- `/ralph pause` - Pause loop and keep it resumable.
- `/ralph stop` - End the active loop (when agent idle).
- `/ralph resume <name>` - Resume loop.
- `/ralph status` - Show loops.
- `/ralph list --archived` - Show archived loops.
- `/ralph archive <name>` - Move loop to archive.
- `/ralph clean [--all]` - Clean completed loops.
- `/ralph cancel <name>` - Delete loop.
- `/ralph nuke [--yes]` - Delete all .ralph data.

Press ESC to interrupt streaming. Run `/ralph pause` to keep the loop resumable, or `/ralph stop` when idle to end it.

For free-form requests, `/ralph create <request>` should have the model choose a short loop name and write `.pi/ralph/tasks/<chosen-name>.md`.

For backlog-backed work, use `/ralph create <backlog-id>` first. The model should inspect the issue with `backlog show <id>` and write `.pi/ralph/tasks/<id>.md`.

## Task File Format

```markdown
# Task Title

Brief description.

## Goals
- Goal 1
- Goal 2

## Checklist
- [ ] Item 1
- [ ] Item 2
- [x] Completed item

## Verification
- Evidence, commands run, or file paths

## Notes
(Update with progress, decisions, blockers)
```

## Best Practices

1. Write a clear checklist with discrete items.
2. Update checklist and notes as you go.
3. Capture verification evidence for completed items.
4. Reflect when stuck to reassess approach.
5. Output the completion marker only when truly done.
