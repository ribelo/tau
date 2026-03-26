---
name: agent-creation
description: Guide for creating custom agent definitions. This skill should be used when users want to create a specialized agent for their project or globally, configure model routing, or customize sandbox policies.
---

# Agent Creation

Create specialized agents by writing `.md` definition files. Agents are discovered from these locations in priority order:

| Location | Priority | Scope |
|----------|----------|-------|
| `.pi/agents/*.md` | Highest | Project-specific |
| `~/.pi/agent/agents/*.md` | Medium | Global (all projects) |
| `extensions/tau/agents/*.md` | Lowest | Bundled defaults |

Project agents override global agents, and global agents override bundled agents.

## Agent Definition File

Create a `.md` file with YAML frontmatter and an optional system prompt body:

```markdown
---
name: my-agent
description: |
  Short description (~500 chars max). Explain when to use this agent,
  what it does, and what it should NOT be used for.
models:
  - model: inherit
    thinking: inherit
tools:
  - read
  - bash
sandbox_fs: workspace-write
sandbox_net: allow-all
approval_policy: never
approval_timeout: 60
---

Optional system prompt content here. This is appended to the default
pi system prompt. If empty, only the default prompt is used.
```

## Frontmatter Fields

### Required

| Field | Description |
|-------|-------------|
| `name` | Agent identifier used in `agent spawn <name>` |
| `description` | When and how to use the agent |
| `models` | Non-empty list of model specs |
| `sandbox_fs` / `sandbox_net` / `approval_policy` / `approval_timeout` | Legacy sandbox fields still supported |

### Optional

| Field | Description |
|-------|-------------|
| `tools` | Exact allowlist of tool names this agent may use |
| `sandbox` | Preferred shorthand for sandbox configuration |

### Model Configuration

`models` is an ordered fallback list. Each entry has:

| Field | Values | Description |
|-------|--------|-------------|
| `model` | `inherit`, `provider/model-id` | Which model to use |
| `thinking` | `low`, `medium`, `high`, `xhigh`, `inherit` | Thinking level |

Examples:
- `model: inherit` keeps the parent model.
- `model: anthropic/claude-sonnet-4-20250514` selects a specific model.
- Multiple entries provide ordered fallback choices.

### Tool Allowlist

Use `tools` to define the exact tool set available to the agent.

```yaml
tools:
  - read
  - bash
  - bd
```

Rules:
- If `tools` is omitted, the agent gets tau's default tool set.
- If `tools` is present, only those tools are enabled.
- Tool names must be unique and must not have leading/trailing whitespace.
- `submit_result` is managed internally for structured-output workers and does not need to be listed.

Typical examples:
- Read-only research agent: `read`, `bash`, `web_search_exa`, `crawling_exa`
- Code review agent: `read`, `bash`
- Implementation agent: `read`, `bash`, `edit`, `write`
- Delegating agent: add `agent`

### Sandbox Configuration

| Field | Values | Description |
|-------|--------|-------------|
| `sandbox` | `read-only`, `workspace-write`, `full-access` | Sandbox preset |
| `sandbox_fs` | `read-only`, `workspace-write`, `danger-full-access` | Legacy filesystem mode |
| `sandbox_net` | `deny`, `allow-all` | Network access |
| `approval_policy` | `never`, `on-failure`, `on-request`, `unless-trusted` | Approval policy |
| `approval_timeout` | positive integer seconds | Auto-deny timeout |

Prefer `sandbox` for new agents unless you need the legacy split fields.

## System Prompt Body

The markdown body after the frontmatter is appended to pi's default prompt.

Guidelines:
- Focus on what makes the agent specialized.
- Include repo-specific workflows or constraints.
- Mention output format if it matters.
- If the agent is analysis-only, state that only the final message is returned.

## Examples

### Read-only Analysis Agent

```markdown
---
name: security-audit
description: |
  Security analysis agent (read-only). Scans code for vulnerabilities,
  auth issues, and unsafe patterns. Use for: security reviews.
  Don't use for: code changes.
models:
  - model: inherit
    thinking: high
tools:
  - read
  - bash
sandbox: read-only
---

Analyze code for concrete security issues. Return findings with severity
and remediation steps.

IMPORTANT: Only your last message is returned to the main agent.
```

### Project-Specific Implementation Agent

```markdown
---
name: rust-impl
description: |
  Rust implementation agent for this project. Use for feature work and
  bug fixes in Rust code. Don't use for architecture decisions.
models:
  - model: inherit
    thinking: medium
tools:
  - read
  - bash
  - edit
  - write
sandbox: workspace-write
---

Follow these project conventions:
- Use `thiserror` for error types
- Prefer `?` over `.unwrap()`
- Run `cargo check && cargo test` before finishing
```

### Delegating Agent

```markdown
---
name: ui-lead
description: |
  Frontend agent that can implement UI work and delegate file discovery.
models:
  - model: inherit
    thinking: inherit
tools:
  - read
  - bash
  - edit
  - write
  - agent
sandbox: workspace-write
---

Use the `agent` tool when you need a finder subagent to map the codebase
before editing.
```

## Settings Overrides

Override models or tools in `.pi/settings.json` or `~/.pi/agent/settings.json`:

```json
{
  "agents": {
    "my-agent": {
      "models": [
        {
          "model": "anthropic/claude-sonnet-4-20250514",
          "thinking": "medium"
        }
      ],
      "tools": ["read", "bash", "bd"],
      "complexity": {
        "low": {
          "models": [
            {
              "model": "anthropic/claude-haiku-3-5-20241022",
              "thinking": "low"
            }
          ]
        },
        "high": {
          "models": [
            {
              "model": "anthropic/claude-sonnet-4-20250514",
              "thinking": "high"
            }
          ]
        }
      }
    }
  }
}
```

Notes:
- `tools` is a top-level override only.
- Complexity overrides currently affect models only.

## Creating a New Agent

1. Choose scope: project (`.pi/agents/`) or global (`~/.pi/agent/agents/`).
2. Create `<name>.md` with frontmatter and optional body.
3. Write a precise description: use cases, non-goals, example prompt.
4. Pick the smallest tool allowlist that can do the job.
5. Pick the smallest sandbox preset that can do the job.
6. Add system prompt instructions only for the specialization.

## Best Practices

- Keep descriptions short and concrete.
- Use `inherit` unless a specific model is required.
- Prefer `read-only` for analysis agents.
- Prefer narrow `tools` lists over broad defaults.
- Use lowercase, descriptive names such as `rust-impl` or `security-audit`.
