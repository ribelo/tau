---
name: agent-creation
description: Guide for creating custom agent definitions. This skill should be used when users want to create a specialized agent for their project or globally, configure model routing, or customize sandbox policies.
---

# Agent Creation

Create specialized agents by writing `.md` definition files. Agents are discovered from these locations (in priority order):

| Location | Priority | Scope |
|----------|----------|-------|
| `.pi/agents/*.md` | Highest | Project-specific |
| `~/.pi/agent/agents/*.md` | Medium | Global (all projects) |
| `extensions/tau/agents/*.md` | Lowest | Bundled defaults |

Project agents override global, global override bundled.

## Agent Definition File

Create a `.md` file with YAML frontmatter and optional system prompt:

```markdown
---
name: my-agent
description: |
  Short description (~500 chars max). Explain when to use this agent,
  what it does, and what it should NOT be used for.
model: inherit
thinking: medium
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
| `name` | Agent identifier (used in `spawn <name>`) |
| `description` | When/how to use this agent. Shown in tool description. |
| `model` | Model ID or `inherit` to use the parent model. |
| `thinking` | Thinking level (`low`, `medium`, `high`, or `inherit`). |
| `sandbox_fs` | Filesystem access level for the agent sandbox. |
| `sandbox_net` | Network access for the agent sandbox. |
| `approval_policy` | When to prompt for approval. |
| `approval_timeout` | Timeout in seconds before auto-deny. |

### Model Configuration

| Field | Values | Description |
|-------|--------|-------------|
| `model` | `inherit`, `provider/model-id` | Which model to use. `inherit` uses parent's model. |
| `thinking` | `low`, `medium`, `high`, `inherit` | Extended thinking level. |

Examples:
- `model: inherit` - use whatever model the parent agent uses
- `model: anthropic/claude-sonnet-4-20250514` - specific model
- `model: openai/gpt-4.1` - OpenAI model

### Sandbox Configuration

| Field | Values | Description |
|-------|--------|-------------|
| `sandbox_fs` | `read-only`, `workspace-write`, `danger-full-access` | Filesystem access level |
| `sandbox_net` | `deny`, `allow-all` | Network access |
| `approval_policy` | `never`, `on-failure`, `on-request`, `unless-trusted` | When to ask for approval |
| `approval_timeout` | number (seconds) | Auto-deny after timeout |

**Sandbox filesystem meanings**:
- `read-only`: Can read files, cannot modify anything
- `workspace-write`: Can read/write within project directory
- `danger-full-access`: Full filesystem access (use with caution)

## System Prompt (Body)

The content after `---` is the system prompt. It's appended to pi's default prompt.

**If empty**: Agent uses only the default pi prompt (like `general` agent).

**Guidelines for system prompts**:
- Focus on what makes this agent specialized
- Include specific instructions, workflows, or constraints
- Reference tools the agent should use
- Specify output format if important
- End with "Only your last message is returned" if agent is used for analysis

## Examples

### Read-only Analysis Agent

```markdown
---
name: security-audit
description: |
  Security analysis agent (read-only). Scans code for vulnerabilities,
  injection risks, auth issues. Use for: security reviews, dependency
  audits. Don't use for: code changes. Prompt example: "Audit src/auth/
  for security vulnerabilities."
model: inherit
thinking: high
sandbox_fs: read-only
sandbox_net: deny
approval_policy: never
approval_timeout: 60
---

Analyze code for security vulnerabilities. Focus on:
- SQL/NoSQL injection
- XSS and CSRF vulnerabilities
- Authentication/authorization flaws
- Insecure dependencies
- Secrets in code

Output findings with severity (Critical/High/Medium/Low) and remediation steps.

IMPORTANT: Only your last message is returned to the main agent.
```

### Project-Specific Implementation Agent

```markdown
---
name: rust-impl
description: |
  Rust implementation agent (workspace-write). Specialized for this
  project's patterns. Use for: implementing features, fixing bugs in
  Rust code. Don't use for: other languages, architecture decisions.
model: inherit
thinking: medium
sandbox_fs: workspace-write
sandbox_net: allow-all
approval_policy: never
approval_timeout: 60
---

Follow these project conventions:
- Use `thiserror` for error types
- Prefer `?` over `.unwrap()`
- Run `cargo clippy` before completing
- Add tests for new functionality

After changes, run: `cargo check && cargo clippy && cargo test`
```

### Minimal Agent (Default Prompt Only)

```markdown
---
name: helper
description: |
  General helper agent with workspace-write access. Uses default pi
  prompt with no specialization. For tasks that don't need custom
  instructions.
model: inherit
thinking: inherit
sandbox_fs: workspace-write
sandbox_net: allow-all
approval_policy: never
approval_timeout: 60
---
```

## Settings Overrides

Override model/thinking per complexity level in `.pi/settings.json` or `~/.pi/agent/settings.json`:

```json
{
  "agents": {
    "my-agent": {
      "model": "anthropic/claude-sonnet-4-20250514",
      "thinking": "medium",
      "complexity": {
        "low": { "model": "anthropic/claude-haiku-3-5-20241022" },
        "high": { "model": "anthropic/claude-sonnet-4-20250514", "thinking": "high" }
      }
    }
  }
}
```

This allows routing to different models based on `complexity` parameter when spawning.

## Creating a New Agent

1. Decide scope: project (`.pi/agents/`) or global (`~/.pi/agent/agents/`)
2. Create `<name>.md` file with frontmatter
3. Write description: when to use, when NOT to use, example prompt
4. Set appropriate sandbox policy (prefer minimal access)
5. Add system prompt if needed (or leave empty for default)
6. Restart pi to load new agent

## Best Practices

- **Descriptions**: Keep under 500 chars. Include "Use for" and "Don't use for".
- **Sandbox**: Use minimum required access. Prefer `read-only` for analysis agents.
- **System prompts**: Focus on specialization. Don't repeat general coding advice.
- **Model**: Use `inherit` unless specific model is required.
- **Naming**: Use lowercase, descriptive names (e.g., `rust-impl`, `security-audit`).
