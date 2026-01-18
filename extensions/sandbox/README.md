# sandbox (tau pi extension)

Sandboxing + approvals for model tool calls (bash/edit/write).

## What this extension does

- Overrides the built-in **bash**, **edit**, and **write** tools.
- Runs **bash** under the Anthropic Sandbox Runtime (ASRT) when available.
- Enforces filesystem restrictions for **edit/write**.
- Provides interactive approvals depending on your approval policy.

This extension intentionally does **not** sandbox user-typed terminal commands (`!` / `!!`). It only applies to model tool calls.

## Installation

Install globally by symlinking this directory into pi’s global extensions folder:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)/extensions/sandbox" ~/.pi/agent/extensions/sandbox
```

Then ensure pi loads extensions from `~/.pi/agent/extensions`.

This repo MUST NOT contain a repo-local `.pi/extensions` directory.

## Configuration

Settings are read from (highest precedence first):

1. session overrides (via `/sandbox` UI)
2. project settings: `<workspace>/.pi/settings.json`
3. user settings: `~/.pi/agent/settings.json`

All settings live under the `sandbox` key.

Example `~/.pi/agent/settings.json`:

```json
{
  "sandbox": {
    "filesystemMode": "workspace-write",
    "networkMode": "deny",
    "networkAllowlist": ["example.com"],
    "approvalPolicy": "on-failure",
    "approvalTimeoutSeconds": 60
  }
}
```

### filesystemMode

- `read-only`: only `/tmp` is writable
- `workspace-write`: workspace is writable (but `.git/hooks/**` is still blocked)
- `danger-full-access`: unrestricted filesystem access

### networkMode

- `deny`: no network access
- `allowlist`: only domains in `networkAllowlist` are reachable
- `allow-all`: unrestricted network access

#### Important ASRT allow-all semantics

ASRT treats `network.allowedDomains: []` as **block all network**.

To truly allow all network, the ASRT `network` config must be **omitted**.

This extension implements `allow-all` by omitting the `network` block.

### approvalPolicy

- `never`: never prompt
- `on-failure`: run sandboxed; if the failure looks like sandbox restriction, prompt to retry without sandbox
- `on-request`: only prompt when the model requests `escalate=true`
- `unless-trusted`: auto-approve “safe” commands; prompt for unsafe ones

## Commands

### `/sandbox`

Opens an interactive UI to adjust sandbox settings for the current session.

### `/approval`

Alias for approval settings (if present in your build).

## Diagnostics

When a sandboxed bash command fails, the tool output may include:

1. a human-readable diagnostic line starting with `[sandbox] ...`
2. a machine-readable line:

```
SANDBOX_DIAGNOSTIC={...json...}
```

This JSON includes the effective modes and a best-effort classification (network/filesystem/unknown).

## Missing dependencies

If ASRT or required OS dependencies are missing, the extension will prompt **once per session** whether it may run bash **without** the OS sandbox.

- If you deny, the command is blocked.
- If you allow, bash runs without ASRT for the rest of the session.
- Edit/write restrictions remain enforced.

### Linux dependencies

- `bwrap` (bubblewrap)
- `socat`
- `python3`

### macOS dependencies

- `sandbox-exec` (usually present by default)

Optional:
- `rg` (ripgrep)

## Troubleshooting

- Seeing DNS failures like `Could not resolve host` can be a symptom of `networkMode: deny`.
- Seeing `Read-only file system` / `EACCES` / `EPERM` can be a symptom of filesystem restrictions.
- If `allow-all` still cannot reach the network, verify you are not forcing an allowlist somewhere in settings/session overrides.
