---
name: task-delegation
description: Guide for delegating work to parallel worker processes. This skill should be used when orchestrating multiple workers, deciding whether to delegate or work directly, understanding coordination patterns, or when encountering task tool errors.
---

# Task Delegation

Delegate work to isolated worker processes that run in parallel. Workers have their own context (don't pollute yours), see AGENTS.md + injected skills + their session history. Only shared state is the codebase.

## When to Delegate vs Work Directly

| Delegate | Work Directly |
|----------|---------------|
| Task would pollute context with large outputs | Quick lookup (< 1 tool call) |
| Multiple independent searches/reviews | Need results for immediate follow-up question |
| Specialized skill needed you don't have loaded | Simple file read or edit |
| User explicitly asks for delegation | Task requires back-and-forth with user |
| Parallel speedup (N tasks in time of 1) | Trivial work not worth coordination overhead |
| Beads task exists and is ready | Ephemeral work (quick search, review, planning) |

**Rule of thumb**: If you'll discard 80% of the output after processing, delegate it.

**Batch sizing**: You wait for the slowest task. Keep tasks in a batch similar in size—one slow task blocks the entire batch.

## Integration with Beads

Typical workflow: chat → plan → create beads tasks → delegate to workers

**Rules of thumb**:
- If a beads task exists and is ready, delegate it
- If work is worth delegating, it's probably worth creating a beads task first (exception: ephemeral work like search, quick review, planning)

When delegating beads work:
- Reference the beads task ID in the prompt (worker can use `bd show <id>` for full context)
- Beads tasks should have good descriptions, notes, and ideally a Definition of Done
- After completion, update/close the beads task

Beads has its own skill for details.

## Definition of Done

Tasks should have clear completion criteria when applicable:

```
✓ Good: "Implement the auth middleware. DoD: all tests pass, no type errors, 
         handles token expiration."
         
✓ Good: "Fix bug in tau-abc123. See beads task for details and acceptance criteria."

✗ Vague: "Work on the auth system"
```

For ephemeral work (search, review, planning), explicit DoD is not required—the nature of the task implies completion.

## API Reference

```typescript
task({
  tasks: [{
    type: string,        // Worker type (user-configured, determines available tools)
    description: string, // Short label for logs/UI
    prompt: string,      // Full instructions - be explicit, workers don't see your conversation
    size?: "small" | "medium" | "large",  // Affects model selection per user config
    session_id?: string, // Continue existing session (must match original type)
    skills?: string[],   // Inject skills (availability depends on type config)
    result_schema?: object // JSON Schema - forces worker to call submit_result
  }]
})
```

**Response format**:
```typescript
[{
  type: string,
  size: string,
  session_id: string | null,
  status: "completed" | "failed" | "interrupted",
  output_type: "completed" | "failed" | "interrupted",
  message: string,
  structured_output?: object
}]
```

## Writing Effective Prompts

Workers don't see your conversation. Be explicit:

```
❌ Bad: "Review the auth changes"

✓ Good: "Review packages/auth/src/ for security issues. Focus on:
         - Input validation
         - SQL injection  
         - Auth token handling
         The project uses TypeScript with Zod for validation."

✓ Good: "Implement tau-xyz123. Run `bd show tau-xyz123` for full context.
         DoD: tests pass, no type errors."
```

Include:
- Specific file paths or directories
- What to look for or accomplish
- Beads task ID if applicable
- Definition of Done for implementation work

## Coordination Patterns

### Fan-out (Parallel Search/Review)

Spawn multiple workers to gather information concurrently:

```typescript
task({ tasks: [
  { type: "search", description: "Find auth files", prompt: "List all files in packages/auth/src/" },
  { type: "search", description: "Find API routes", prompt: "Find all files matching **/routes/*.ts" },
  { type: "search", description: "Find tests", prompt: "Find all *.test.ts files" }
]})
// All run in parallel, aggregate results yourself
```

### Pipeline (Sequential Handoff)

Use session continuation for multi-step work:

```typescript
// Step 1: Search
const [{ session_id, message }] = task({ tasks: [
  { type: "search", prompt: "Find all TODO comments in src/" }
]})

// Step 2: Continue with analysis (you process results, then continue)
task({ tasks: [
  { type: "planning", session_id, prompt: `Prioritize these TODOs: ${message}` }
]})
```

### Specialist (Skill Injection)

Inject domain knowledge for specialized work:

```typescript
task({ tasks: [
  { type: "custom", skills: ["beads"], prompt: "Create tasks for the auth refactor epic" },
  { type: "custom", skills: ["review"], prompt: "Review the PR against coding standards" }
]})
```

### Delegating Beads Tasks

When beads tasks exist, delegate them directly:

```typescript
task({ tasks: [
  { type: "code", description: "tau-abc123", prompt: "Implement tau-abc123. Run `bd show tau-abc123` for context. DoD: tests pass, no type errors." },
  { type: "code", description: "tau-def456", prompt: "Implement tau-def456. Run `bd show tau-def456` for context. DoD: tests pass, no type errors." }
]})
```

## Session Continuation

Sessions persist worker context across calls:

```typescript
// Start session
const [{ session_id }] = task({ tasks: [
  { type: "code", prompt: "Read config.ts and summarize the settings" }
]})

// Continue same session - worker remembers previous context
task({ tasks: [
  { type: "code", session_id, prompt: "Now update the timeout setting to 5000" }
]})
```

**Constraints**:
- `session_id` must match original type
- Invalid `session_id` returns error (won't silently create new session)
- Sessions are for same-day work, not long-term storage

## Validation Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Unknown session_id: X` | Session doesn't exist | Omit `session_id` to start fresh |
| `Missing skills: X, Y` | Skill not found | Check available skills, fix typo |
| `skills is only valid for type=custom` | Used skills with wrong type | Use appropriate type |
| `session_id X belongs to type=Y, not Z` | Type mismatch on continuation | Use original type |

## Key Behaviors

- **Parallel execution**: All tasks in array run concurrently
- **Blocking**: You wait for all tasks to complete before continuing
- **Independent failure**: Each task succeeds/fails independently in batch
- **Context isolation**: Workers don't see your conversation or each other
- **Nesting**: Allowed up to max depth 3; avoid unless required
- **Codebase is shared state**: Workers read/write same files—coordinate to avoid conflicts
