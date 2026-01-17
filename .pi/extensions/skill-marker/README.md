# skill-marker pi extension

Adds codex-style `$skillname` markers:

- Autocomplete for `$skillname` in the editor (inserts `$beads`, not expanded text)
- Before each turn, injects the referenced skill(s) as separate `<skill>...</skill>` blocks into the conversation context

## Install (project-local)

This extension is auto-discovered by pi when you run pi in this repository because it lives in:

- `./.pi/extensions/skill-marker/index.ts`

## Install (global)

Copy the directory to your global pi extensions folder:

- `~/.pi/agent/extensions/skill-marker/index.ts`

## Usage

Type a skill marker in your prompt:

- `$beads`

Press Tab to autocomplete.

Escape a marker to keep it literal:

- `\\$beads`

Multiple markers are supported (deduped by first mention order):

- `$beads $search do ...`

## Notes / limitations

- Markers are **not** expanded inline. The extension injects a separate message before the model is called.
- Markers are only recognized at the beginning of the prompt or after whitespace.
- Skill names are restricted to `[a-z0-9-]+` (lowercase) to avoid clobbering env vars like `$PATH`.
- Injected instructions strip YAML frontmatter (same as pi `/skill:name` expansion).
- Injected instructions are truncated at pi defaults: **50KB or 2000 lines** (whichever hits first).
- Injection runs on normal prompts. It does **not** currently inject skills into queued steering/follow-up messages sent while the agent is streaming.

## Manual QA checklist

1. **Autocomplete ($ marker)**
   - Type `$be` then press Tab.
   - Expect a suggestion list including `beads` (if that skill exists in your skill directories).
   - Select it; expect the editor to contain `$beads` (and not the full skill body).

2. **Autocomplete regression checks**
   - Type `/mo` + Tab: command completion should still work.
   - Type `@REA` + Tab: file completion should still work.

3. **Injection behavior**
   - Send: `$beads what is the bd command to show ready issues?`
   - Expect the assistant to answer using the beads skill guidance.

4. **Multiple skills**
   - Send a prompt referencing two skills you have locally, e.g. `$beads $search ...`.
   - Expect the assistant to follow both.

5. **Escaping**
   - Send: `\\$beads should stay literal`.
   - Expect no skill injection; the assistant should treat it as literal text.

6. **Unknown skill**
   - Send: `$this-skill-does-not-exist test`.
   - Expect a UI warning about unknown skills (interactive mode).
