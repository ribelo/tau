---
name: bash
description: Multi-step bash workflows and system operations. Covers system detection, package management, and distro-agnostic practices.
---

# Bash

Execute multi-step command workflows. Operations, not implementation.

## First: Check Assumptions

**NEVER assume Ubuntu/Debian.** Always detect the system first:

```bash
# What distro?
cat /etc/os-release 2>/dev/null | grep -E "^ID=|^ID_LIKE="

# What's available?
command -v apt    # Debian/Ubuntu
command -v pacman # Arch
command -v nix    # NixOS
command -v brew   # macOS
command -v dnf    # Fedora
```

## NixOS Specifics

NixOS is different from "normal" distros:

- **No `/usr/bin/`** - binaries in `/nix/store/`
- **No `apt`/`yum`/`pacman`** - uses `nix-env` or `nix-shell`
- **Declarative config** - `/etc/nixos/configuration.nix`
- **Ephemeral environments** - `nix-shell -p package`

### Common NixOS Patterns

```bash
# Check if NixOS
[[ -f /etc/NIXOS ]] && echo "NixOS detected"

# Temporary package access (doesn't install)
nix-shell -p nodejs --run "node --version"

# Check if in nix-shell already
[[ -n "$IN_NIX_SHELL" ]] && echo "Already in nix-shell"

# Find where a command comes from
which node  # Shows /nix/store/... path
```

### What NOT to do on NixOS

```bash
# WRONG - apt doesn't exist
apt install nodejs

# WRONG - won't persist, wrong approach
sudo npm install -g something

# WRONG - paths don't exist
/usr/bin/env python
```

### What TO do on NixOS

```bash
# Use nix-shell for temporary access
nix-shell -p python3 --run "python --version"

# Check if package available in current shell
command -v node || echo "node not in PATH - need nix-shell?"

# Use project's shell.nix/flake.nix if exists
[[ -f shell.nix ]] && echo "Use: nix-shell"
[[ -f flake.nix ]] && echo "Use: nix develop"
```

## System Detection Pattern

Start workflows with:

```bash
# Detect system
OS=$(uname -s)
if [[ -f /etc/os-release ]]; then
  . /etc/os-release
  DISTRO=$ID
else
  DISTRO="unknown"
fi

echo "OS: $OS, Distro: $DISTRO"

# Adapt commands
case "$DISTRO" in
  nixos)
    # Check for shell.nix or flake.nix
    [[ -f shell.nix ]] && echo "Enter nix-shell first"
    ;;
  ubuntu|debian)
    command -v apt && echo "apt available"
    ;;
  arch)
    command -v pacman && echo "pacman available"
    ;;
esac
```

## Multi-Step Workflows

### Error Handling

```bash
# Stop on first error
set -e

# Or check each step
npm install || { echo "npm install failed"; exit 1; }
npm run build || { echo "build failed"; exit 1; }
npm test || { echo "tests failed"; exit 1; }
```

### Parallel Commands

```bash
# Run in parallel, wait for all
npm run build:a &
npm run build:b &
npm run build:c &
wait
```

### Conditional Execution

```bash
# Only if command exists
command -v cargo && cargo build --release

# Only if file exists
[[ -f package.json ]] && npm install
[[ -f Cargo.toml ]] && cargo build
[[ -f requirements.txt ]] && pip install -r requirements.txt
```

## Common Patterns

### Node.js project

```bash
[[ -f package-lock.json ]] && npm ci || npm install
npm run build
npm test
```

### Rust project

```bash
cargo build --release
cargo test
```

### Python project

```bash
# Check for venv
[[ -d .venv ]] && source .venv/bin/activate
pip install -r requirements.txt
python -m pytest
```

### Docker

```bash
docker build -t myapp .
docker run --rm myapp npm test
```

## Key Rules

1. **Detect first, assume never** - Check what system you're on
2. **Check command existence** - `command -v X` before using X
3. **Handle errors** - Use `set -e` or check exit codes
4. **Report clearly** - Echo what you're doing
5. **Be idempotent** - Safe to run twice
