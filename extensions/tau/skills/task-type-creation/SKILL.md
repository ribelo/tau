---
name: task-type-creation
description: Guide for creating custom task types for worker delegation. This skill should be used when users want to define new task types, configure model routing per complexity level, or customize tool access for workers.
---

# Task Type Creation

Custom task types configure how workers behave: model, tools, and default skills.

## Configuration Locations

| Location | Priority | Scope |
|----------|----------|-------|
| `~/.pi/agent/settings.json` | Lower | Global (all projects) |
| `.pi/settings.json` (in project) | Higher | Project-specific |

Project settings override global. Settings merge with builtins.

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
| `description` | string | Short description |
| `model` | string | `provider/model-id` or `"inherit"` |
| `tools` | string[] | Allowed tools. Omit for all. |
| `skills` | string[] | Default skills to inject |
| `defaultThinking` | string | `off`, `minimal`, `low`, `medium`, `high` |
| `complexity` | object | Per-complexity model/thinking overrides |

## Model Configuration

Two options (mutually exclusive):

### Single model

```json
{
  "tasks": {
    "rust": {
      "description": "Rust implementation",
      "model": "anthropic/claude-sonnet-4-20250514"
    }
  }
}
```

### Per-complexity models

```json
{
  "tasks": {
    "rust": {
      "description": "Rust implementation",
      "complexity": {
        "low": { "model": "anthropic/claude-haiku-3-5-20241022" },
        "medium": { "model": "anthropic/claude-sonnet-4-20250514" },
        "high": { "model": "anthropic/claude-opus-4-20250514", "thinking": "high" }
      }
    }
  }
}
```

**Fallback**: If requested complexity not configured, tries higher first, then lower.

## Examples

### Cheap search worker

```json
{
  "tasks": {
    "search": {
      "complexity": {
        "low": { "model": "anthropic/claude-haiku-3-5-20241022" },
        "high": { "model": "google/gemini-2.5-pro" }
      }
    }
  }
}
```

### Thinking-enabled advisor

```json
{
  "tasks": {
    "advisor": {
      "complexity": {
        "medium": { "model": "anthropic/claude-sonnet-4-20250514" },
        "high": { "model": "anthropic/claude-opus-4-20250514", "thinking": "high" }
      }
    }
  }
}
```

### Project-specific type

```json
{
  "tasks": {
    "frontend": {
      "description": "Frontend React work",
      "model": "anthropic/claude-sonnet-4-20250514",
      "skills": ["react-patterns"]
    }
  }
}
```

## Built-in Task Types

| Name | Description | Tools | Skills |
|------|-------------|-------|--------|
| `code` | Edit files, implement, fix bugs | All | code |
| `search` | Find files, locate patterns | read, bash | search |
| `review` | Review diffs, structured JSON | read, bash | review |
| `planning` | Design solutions, create plans | read, bash | planning |
| `advisor` | Expert guidance for hard problems | read, bash | advisor, simplicity, analysis |
| `refactor` | Rename, transform across files | All | ast-grep, fastmod |
| `bash` | Run commands, install, build | bash, read | bash |
| `custom` | Ad-hoc worker with skills you specify | All | (you provide) |

## Sandbox Configuration

Each task type can have its own sandbox configuration. **Worker sandbox settings are clamped to the parent's effective configuration.** You cannot use a worker sandbox to escape parent restrictions.

```json
{
  "tasks": {
    "safe-worker": {
      "description": "A worker that never prompts for approval",
      "sandbox": {
        "filesystemMode": "read-only",
        "networkMode": "deny",
        "approvalPolicy": "never"
      }
    }
  }
}
```

### Sandbox Fields

| Field | Type | Options |
|-------|------|---------|
| `filesystemMode` | string | `read-only`, `workspace-write`, `danger-full-access` |
| `networkMode` | string | `deny`, `allowlist`, `allow-all` |
| `networkAllowlist` | string[] | Domains allowed (if mode is `allowlist`) |
| `approvalPolicy` | string | `never`, `on-failure`, `on-request`, `unless-trusted` |
| `approvalTimeoutSeconds` | number | Seconds to wait for approval before timeout |

## Available Tools

`read`, `write`, `edit`, `bash`, `bd`, `task`, `web_search_exa`, `crawling_exa`, `get_code_context_exa`, `git_commit_with_user_approval`

## Applying Changes

Restart pi after editing settings.
