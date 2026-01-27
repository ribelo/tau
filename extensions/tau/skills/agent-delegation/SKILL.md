---
name: agent-delegation
description: Guide for delegating work to parallel agents. This skill should be used when orchestrating multiple agents, deciding whether to delegate or work directly, understanding coordination patterns, or integrating agent work with beads tasks.
---

# Agent Delegation

Delegate work to isolated agents that run in parallel. Agents have their own context (don't pollute yours), see AGENTS.md + their session history. Only shared state is the codebase.

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
- `timeout_ms`: Max wait time (default 30000, max 300000)

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
- Reference beads task ID when applicable - agent can run `bd show <id>` for full context

```
Bad: "Review the auth changes"

Bad: "Change line 42 to: const x = foo.bar()" (don't include code)

Good: "Review packages/auth/src/ for security issues. Focus on:
      - Input validation
      - SQL injection  
      - Auth token handling
      The project uses TypeScript with Zod for validation."

Good: "Implement tau-xyz123. Run `bd show tau-xyz123` for full context.
      DoD: tests pass, no type errors."
```

## Beads as Communication Channel

Beads tasks serve as a communication mechanism between you and agents:

**Orchestrator → Agent**:
- Create beads task with detailed description, context, and Definition of Done
- Delegate with: "Implement tau-xyz. Run `bd show tau-xyz` for context."
- Agent reads full task details via `bd show`

**Agent → Orchestrator**:
- Agent can add notes to beads task: `bd update tau-xyz --note "Found issue with X"`
- Agent can create child tasks for discovered work: `bd create "Fix Y" --parent tau-xyz`
- Orchestrator checks task notes after completion

**Capturing Discovered Work**:
- If agent finds issues outside current scope, create new beads tasks
- Never lose discovered work - track it in beads
- Split large/vague tasks into actionable sub-tasks

## Coordination Patterns

### Fan-out (Parallel Search)

Spawn multiple agents to gather information concurrently:

```
spawn finder "Find all authentication middleware" → id1
spawn finder "Find all API route handlers" → id2
spawn finder "Find all test files for auth" → id3
wait [id1, id2, id3] → all results
```

### Session Continuation

Use send for true follow-ups where agent context is valuable:

```
spawn finder "Find all files that handle user sessions" → id
wait [id] → file list
send id "Now find where session expiration is checked" → submission_id
wait [id] → refined results
```

### Parallel Implementation

Delegate independent implementation tasks:

```
spawn rush "In src/utils.ts, add input validation to parseConfig()" → id1
spawn rush "In src/api.ts, add rate limiting to /login endpoint" → id2
wait [id1, id2] → both done
```

### Beads-Driven Delegation

When beads tasks exist, delegate them directly:

```
spawn general "Implement tau-abc123. Run `bd show tau-abc123` for context." → id1
spawn general "Implement tau-def456. Run `bd show tau-def456` for context." → id2
wait [id1, id2]
# Check task notes for any discovered issues
bd show tau-abc123
bd show tau-def456
# Close completed work
bd close tau-abc123
bd close tau-def456
```

## Integration with Beads

Typical workflow: chat → plan → create beads tasks → delegate to agents

**Rules of thumb**:
- If a beads task exists and is ready, delegate it
- If work is worth delegating, it's probably worth creating a beads task first
- Exception: ephemeral work (search, quick review, planning)

**After delegation completes**:
- Check task notes for agent findings
- Review any child tasks agent created
- Close completed tasks or update status
- Create follow-up tasks for remaining work

## Definition of Done

Tasks should have clear completion criteria:

```
Good: "Implement the auth middleware. DoD: all tests pass, no type errors, 
      handles token expiration."
         
Good: "Fix bug in tau-abc123. See beads task for details and acceptance criteria."

Vague: "Work on the auth system"
```

For ephemeral work (search, review, planning), explicit DoD is not required.

## Key Behaviors

- **Parallel execution**: Spawned agents run concurrently
- **Join semantics**: `wait` blocks until ALL specified agents complete
- **Independent failure**: Each agent succeeds/fails independently
- **Context isolation**: Agents don't see your conversation or each other
- **Codebase is shared state**: Agents read/write same files—coordinate to avoid conflicts
