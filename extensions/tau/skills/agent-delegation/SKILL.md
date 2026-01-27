---
name: agent-delegation
description: Guide for delegating work to parallel agents. This skill should be used when orchestrating multiple agents, deciding whether to delegate or work directly, or understanding coordination patterns.
---

# Agent Delegation

Delegate work to isolated agents that run in parallel. Agents have their own context (don't pollute yours), see AGENTS.md + skills. Only shared state is the codebase.

**Core principle**: Use agents to keep your context clean. Delegate work that would pollute your context with large outputs, then aggregate results.

## When to Delegate vs Work Directly

| Delegate | Work Directly |
|----------|---------------|
| Task would pollute context with large outputs | Quick lookup (< 1 tool call) |
| Multiple independent searches/reviews | Need results for immediate follow-up question |
| Parallel speedup (N tasks in time of 1) | Simple file read or edit |
| User explicitly asks for delegation | Task requires back-and-forth with user |
| Beads task exists and is ready | Trivial work not worth coordination overhead |

**Rule of thumb**: If you'll discard 80% of the output after processing, delegate it.

## The `agent` Tool

### Actions

| Action | Purpose | Required params |
|--------|---------|-----------------|
| `spawn` | Start agent in background | `agent`, `message` |
| `wait` | Block until agents complete | `ids` |
| `send` | Continue conversation with existing agent | `id`, `message` |
| `close` | Terminate agent | `id` |
| `list` | Show all agents | none |

### Spawn

```
agent spawn <agent-name> "<instructions>"
```

Parameters:
- `agent`: Agent name (finder, rush, general, oracle, librarian, painter, review)
- `message`: Full instructions for the agent
- `complexity`: Model routing - `low` (fast/cheap), `medium` (default), `high` (capable/expensive)
- `result_schema`: JSON schema for structured output (agent must call submit_result)

Returns `agent_id` immediately. Agent runs in background.

### Wait

```
agent wait [id1, id2, ...]
```

Blocks until ALL agents complete. Returns status map with results.

Parameters:
- `ids`: Array of agent IDs to wait for
- `timeout_ms`: Max wait time (default 15 min, max 4 hours)

### Send (Session Continuation)

```
agent send <id> "<follow-up message>"
```

Continue conversation with an existing agent. The agent keeps its context from previous work.

**When to use send vs spawn new**:
- `send`: True follow-up to previous work (agent has relevant context)
- `spawn new`: Different task (don't pollute agent's context with unrelated work)

Parameters:
- `id`: Agent ID
- `message`: Follow-up instructions
- `interrupt`: If true, abort current work before sending new message

### Close

```
agent close <id>
```

Terminate a running agent. Use to cancel work you no longer need.

## Available Agents

| Agent | Sandbox | Use for |
|-------|---------|---------|
| `finder` | read-only | Locating code by concept, multi-step search |
| `rush` | workspace-write | Small well-defined tasks, quick fixes |
| `general` | workspace-write | Substantial multi-step work, full pi capabilities |
| `oracle` | read-only | Analysis, planning, architectural advice |
| `librarian` | read-only | Deep codebase understanding, tracing flow |
| `painter` | workspace-write | Frontend/UI work |
| `review` | read-only | Code review, finding bugs |

## Writing Effective Prompts

Agents don't see your conversation. Be explicit but high-level.

**Prompt guidelines**:
- Keep prompts conceptual and high-level
- Do NOT include code snippets in delegation prompts
- Specify file paths, what to accomplish, and Definition of Done
- Reference beads task ID - agent will use `bd show <id>` for context

```
Bad: "Review the auth changes"

Bad: "Change line 42 to: const x = foo.bar()" (don't include code)

Good: "Review packages/auth/src/ for security issues. Focus on:
      - Input validation
      - SQL injection  
      - Auth token handling
      The project uses TypeScript with Zod for validation."

Good: "Implement tau-xyz123. DoD: tests pass, no type errors."
```

## Coordination Patterns

### Fan-out (Parallel Search)

```
spawn finder "Find all authentication middleware" → id1
spawn finder "Find all API route handlers" → id2
spawn finder "Find all test files for auth" → id3
wait [id1, id2, id3] → all results
```

### Session Continuation

```
spawn finder "Find all files that handle user sessions" → id
wait [id] → file list
send id "Now find where session expiration is checked"
wait [id] → refined results
```

### Parallel Implementation

```
spawn rush "In src/utils.ts, add input validation to parseConfig()" → id1
spawn rush "In src/api.ts, add rate limiting to /login endpoint" → id2
wait [id1, id2] → both done
```

### Beads-Driven Delegation

```
spawn general "Implement tau-abc123. DoD: tests pass, no type errors." → id1
spawn general "Implement tau-def456. DoD: tests pass, no type errors." → id2
wait [id1, id2]
bd close tau-abc123
bd close tau-def456
```

## Parallelization Safety

You are responsible for ensuring parallel tasks don't conflict.

**Safe to parallelize freely:**
- Read-only agents: `finder`, `oracle`, `librarian`, `review`
- Tasks on different files/directories

**Requires coordination:**
- Write agents (`rush`, `general`, `painter`) on same file - DO NOT parallelize
- Tasks with dependencies - serialize them

**Before spawning parallel write tasks, verify:**
1. Tasks touch different files
2. No shared dependencies between tasks
3. Order doesn't matter

**If unsure**: serialize instead of parallelize. Correctness > speed.

```
Safe:
  spawn rush "Fix typo in src/auth.ts" → id1
  spawn rush "Fix typo in src/api.ts" → id2
  wait [id1, id2]  # Different files, safe

Unsafe:
  spawn rush "Add validation to src/utils.ts" → id1
  spawn rush "Add logging to src/utils.ts" → id2
  wait [id1, id2]  # Same file, will conflict!
```

## Git Responsibility

**You (orchestrator) own git.** Agents are forbidden from committing or mutating git state.

Your responsibilities:
- Commit changes after verifying agent work
- Handle merge conflicts if they arise
- Push to remote when work is complete
- Run `bd sync` to persist beads

Agents will only read/write files. They won't touch git.

## Key Behaviors

- **Parallel execution**: Spawned agents run concurrently
- **Join semantics**: `wait` blocks until ALL specified agents complete
- **Independent failure**: Each task succeeds/fails independently
- **Context isolation**: Agents don't see your conversation or each other
- **Beads-aware**: Agents know to use `bd show`, add notes, and create tasks for discovered issues
- **Git-safe**: Agents never commit or mutate git - orchestrator handles all git operations
