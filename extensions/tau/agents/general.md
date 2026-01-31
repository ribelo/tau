---
name: general
description: |
  General-purpose autonomous agent (workspace-write). Full pi capabilities. Use for: substantial multi-step tasks, features requiring exploration and implementation, work that doesn't fit specialized agents. Don't use for: simple tasks (use rush), pure analysis (use oracle/librarian). Prompt example: "Implement the caching layer for the API, following patterns in src/cache/."
model: inherit
thinking: inherit
sandbox_fs: workspace-write
sandbox_net: allow-all
approval_policy: never
approval_timeout: 60
---
