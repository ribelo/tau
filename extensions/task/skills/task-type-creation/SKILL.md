---
name: task-type-creation
description: Guide for creating custom task types for worker delegation. This skill should be used when users want to define new task types, configure model routing per complexity level, or customize tool access for workers.
---

# Task Type Creation

Custom task types configure how workers behave: which model they use, which tools they have access to, and which skills are injected by default.

## Configuration Locations

| Location | Priority | Scope |
|----------|----------|-------|
| `~/.pi/agent/settings.json` | Lower | Global (all projects) |
| `.pi/settings.json` (in project) | Higher | Project-specific |

Project settings override global settings. Settings merge with builtins.

## Basic Structure

```json
{
  "tasks": {
    "task-name": {
      "description": "What this task type does",
      "model": "provider/model-id",
      "tools": ["read", "write", "edit", "bash"],
      "skills": ["skill-name"],
      "defaultThinking": "medium"
    }
  }
}
```

## Fields

| Field | Type | Description |
|-------|------|-------------|
| `description` | string | Short description shown to agents |
| `model` | string | Model to use (`provider/model-id`) or `"inherit"` to use parent's model |
| `tools` | string[] | Allowed tools. Omit for all tools. |
| `skills` | string[] | Skills injected by default |
| `defaultThinking` | string | Thinking level: `off`, `minimal`, `low`, `medium`, `high` |
| `complexity` | object | Per-complexity model/thinking overrides (see below) |

## Model Configuration

Two options (mutually exclusive):

### Option 1: Single model for all complexity levels

```json
{
  "tasks": {
    "rust": {
      "description": "Rust implementation work",
      "model": "anthropic/claude-sonnet-4-20250514"
    }
  }
}
```

### Option 2: Different models per complexity

```json
{
  "tasks": {
    "rust": {
      "description": "Rust implementation work",
      "complexity": {
        "low": { "model": "anthropic/claude-haiku-3-5-20241022" },
        "medium": { "model": "anthropic/claude-sonnet-4-20250514" },
        "high": { "model": "anthropic/claude-opus-4-20250514", "thinking": "high" }
      }
    }
  }
}
```

**Fallback logic**: If requested complexity is not configured, falls back to nearest higher level first, then lower.

Example: If only `high` is configured and `complexity: "low"` is requested → uses `high` config.

## Tool Restrictions

Restrict which tools workers can use:

```json
{
  "tasks": {
    "safe-search": {
      "description": "Read-only search",
      "tools": ["read", "ls", "find", "grep"]
    }
  }
}
```

Omit `tools` to allow all tools.

## Default Skills

Inject skills automatically for a task type:

```json
{
  "tasks": {
    "rust-dev": {
      "description": "Rust development with specialized knowledge",
      "skills": ["rust-patterns", "cargo-workspace"]
    }
  }
}
```

Workers can still receive additional skills via the `skills` parameter in task calls.

## Examples

### Cheap search worker

Route low-complexity searches to a fast, cheap model:

```json
{
  "tasks": {
    "search": {
      "complexity": {
        "low": { "model": "anthropic/claude-haiku-3-5-20241022" },
        "medium": { "model": "anthropic/claude-sonnet-4-20250514" },
        "high": { "model": "google/gemini-2.5-pro" }
      }
    }
  }
}
```

### Thinking-enabled code worker

Use extended thinking for high-complexity implementation:

```json
{
  "tasks": {
    "code": {
      "complexity": {
        "low": { "model": "anthropic/claude-sonnet-4-20250514" },
        "high": { "model": "anthropic/claude-opus-4-20250514", "thinking": "high" }
      }
    }
  }
}
```

### Project-specific type

In `.pi/settings.json` at project root:

```json
{
  "tasks": {
    "frontend": {
      "description": "Frontend React work",
      "model": "anthropic/claude-sonnet-4-20250514",
      "skills": ["react-patterns"],
      "tools": ["read", "write", "edit", "bash", "ls", "find", "grep"]
    }
  }
}
```

### Override builtin

Override the built-in `code` type to use a different model:

```json
{
  "tasks": {
    "code": {
      "model": "openai/gpt-4.1"
    }
  }
}
```

Overrides merge with the builtin definition.

## Built-in Task Types

These exist by default and can be overridden:

| Name | Description | Tools | Default Skills |
|------|-------------|-------|----------------|
| `code` | General implementation | All | None |
| `search` | Find code/definitions | read, ls, find, grep | search |
| `review` | Code review | read, ls, find, grep, bash | review |
| `planning` | Architecture decisions | read, ls, find, grep | planning |
| `custom` | User-specified skills | All | None |

## Applying Changes

After editing settings, restart pi to reload the task registry.
