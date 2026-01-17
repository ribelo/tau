# skill-marker (pi extension)

Codex-style `$skillname` markers for pi.

## Features

- Autocomplete for `$skillname` in the editor
  - typing `$` (after whitespace / at start) auto-opens suggestions
  - Tab also forces completion
  - selecting a suggestion inserts **`$skillname` only** (never expands inline)
- Before each turn, injects referenced skill(s) as separate `<skill>...</skill>` blocks into the conversation context.

## Install (global)

Tau is a bag of pi extensions. Install by linking (or copying) extension packages from this repo into your global pi extensions directory:

- Global pi extensions dir: `~/.pi/agent/extensions`

Symlink:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)/extensions/skill-marker" ~/.pi/agent/extensions/skill-marker
```

Or use the helper script:

```bash
./scripts/pi/install-extensions.sh
```

## Usage

Type a marker:

- `$beads`

Escape a marker to keep it literal:

- `\\$beads`

## Notes

- Markers are only recognized at beginning-of-line or after whitespace.
- Skill names are restricted to `[a-z0-9-]+`.
- Injected instructions strip YAML frontmatter and are truncated at pi defaults (50KB / 2000 lines).
