---
name: task-delegation
description: Guide for delegating work to parallel worker processes. This skill should be used when orchestrating multiple workers, deciding whether to delegate or work directly, understanding coordination patterns, or when encountering agent tool errors.
---

# Agent Delegation

Delegate work to isolated agent processes that run in parallel. Agents have their own context (don't pollute yours), see AGENTS.md + injected skills + their session history. Only shared state is the codebase.

The system is **non-blocking**: you spawn agents, do other work, and then wait for their results.

## Worker Selection Guide

Built-in types (users can define more via settings):

| Need | Worker |
|------|--------|
| "Edit files, implement features" | `code` |
| "Find code matching concept" | `search` |
| "Review changes for bugs" | `review` |
| "Design solution, create plan" | `planning` |
| "Senior engineer for hard problem" | `advisor` |
| "Rename/transform across codebase" | `refactor` |
| "Install deps, run scripts, build" | `bash` |
| "Need specific skill combination" | `custom` + skills[] |

## When to Delegate vs Work Directly

| Delegate | Work Directly |
|----------|---------------|
| Task would pollute context with large outputs | Quick lookup (< 1 tool call) |
| Multiple independent searches/reviews | Need results for immediate follow-up |
| Specialized skill needed | Simple file read or edit |
| Parallel speedup (N tasks in time of 1) | Describing task > doing it |
| Beads task exists and is ready | Task requires user back-and-forth |

**Rule of thumb**: If you'll discard 80% of the output after processing, delegate it.

## Integration with Beads

Typical workflow: chat → plan → create beads tasks → delegate to agents

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
agent({
  action: "spawn" | "send" | "wait" | "close" | "list",
  
  // spawn
  type: string,        // Worker type
  message: string,      // Initial prompt
  complexity?: "low" | "medium" | "high",
  skills?: string[],   // Extra skills (only for type=custom)
  result_schema?: object, // JSON Schema for structured output
  
  // send/close
  id?: string,         // Agent ID
  interrupt?: boolean, // (send) interrupt current turn
  
  // wait
  ids?: string[],      // Agent IDs to wait for
  timeout_ms?: number  // Timeout (default 30s, max 300s)
})
```

### Action Responses

- **spawn**: `{ agent_id: string }`
- **send**: `{ submission_id: string }`
- **wait**: `{ status: Record<id, Status>, timedOut: boolean }`
- **close**: `{ status: "closed" }`
- **list**: `{ agents: AgentInfo[] }`

## Coordination Patterns

### Fan-out (Parallel Search/Review)

Spawn multiple agents and wait for all of them:

```typescript
// Spawn agents
const { agent_id: id1 } = agent({ action: 'spawn', type: 'search', message: 'Find auth files' })
const { agent_id: id2 } = agent({ action: 'spawn', type: 'search', message: 'Find API routes' })

// Wait for results (blocks until at least one finishes or timeout)
const { status } = agent({ action: 'wait', ids: [id1, id2] })
```

### Pipeline (Interactive Refinement)

Use `send` to continue work in an existing agent:

```typescript
// Step 1: Request draft
const { agent_id } = agent({ action: 'spawn', type: 'code', message: 'Draft the function' })

// Step 2: Wait for it
agent({ action: 'wait', ids: [agent_id] })

// Step 3: Refine
agent({ action: 'send', id: agent_id, message: 'Add error handling' })
```

### Specialist (Skill Injection)

```typescript
agent({ action: 'spawn', type: 'custom', skills: ['beads'], message: 'Create tasks for the epic' })
```

## Key Behaviors

- **Non-blocking**: `spawn` and `send` return immediately.
- **Explicit wait**: Use `wait` to block until agents reach a final state.
- **Inter-agent communication**: Use `send` to give further instructions to a running agent.
- **Context isolation**: Agents don't see your conversation or each other.
- **Nesting**: Allowed up to max depth 3.
- **Shared state**: Agents read/write same files—coordinate to avoid conflicts.
