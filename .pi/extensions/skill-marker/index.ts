import type { ExtensionAPI, KeybindingsManager } from "@mariozechner/pi-coding-agent";
import {
	CustomEditor,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	discoverSkills,
	getAgentDir,
	loadSettings,
	stripFrontmatter,
	truncateHead,
	type Skill,
} from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider, EditorTheme, TUI } from "@mariozechner/pi-tui";
import { fuzzyFilter } from "@mariozechner/pi-tui";
import { readFile } from "node:fs/promises";

/**
 * skill-marker
 *
 * Codex-inspired behavior:
 * - `$skillname` stays in the user prompt (marker)
 * - Extension injects a separate `<skill>...</skill>` message before the model is called
 * - Editor autocomplete inserts `$skillname` only (no expansion)
 */

// ============================================================================
// Configuration
// ============================================================================

const ENABLED = true;

// Skill marker rules (as decided in tau-2lq.1)
const SKILL_MARKER_REGEX = /(?:^|\s)\$([a-z0-9][a-z0-9-]*)(?=$|[^a-z0-9-])/g;
const SKILL_AUTOCOMPLETE_REGEX = /(?:^|\s)(\$[a-z0-9-]*)$/;

// ============================================================================
// Skill registry (discovery + caching)
// ============================================================================

type SkillInfo = {
	name: string;
	description: string;
	path: string;
	baseDir: string;
};

type SkillBody = {
	path: string;
	text: string;
	truncated: boolean;
};

class SkillRegistry {
	private byName = new Map<string, SkillInfo>();
	private bodyCache = new Map<string, SkillBody>();

	refresh(skills: Skill[]): void {
		this.byName.clear();
		for (const s of skills) {
			this.byName.set(s.name, {
				name: s.name,
				description: s.description,
				path: s.filePath,
				baseDir: s.baseDir,
			});
		}
		this.bodyCache.clear();
	}

	getAll(): SkillInfo[] {
		return [...this.byName.values()];
	}

	get(name: string): SkillInfo | undefined {
		return this.byName.get(name);
	}

	/**
	 * Read and cache the SKILL.md body (frontmatter stripped).
	 * Applies truncation to avoid blowing up context.
	 */
	async getBody(name: string): Promise<SkillBody | undefined> {
		const cached = this.bodyCache.get(name);
		if (cached) return cached;

		const info = this.byName.get(name);
		if (!info) return undefined;

		const raw = await readFile(info.path, "utf-8");
		const body = stripFrontmatter(raw).trim();
		const truncation = truncateHead(body, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });

		const result: SkillBody = {
			path: info.path,
			text: truncation.content,
			truncated: truncation.truncated,
		};
		this.bodyCache.set(name, result);
		return result;
	}
}

// ============================================================================
// Autocomplete provider wrapper
// ============================================================================

class SkillMarkerAutocompleteProvider implements AutocompleteProvider {
	private base: AutocompleteProvider;
	private registry: SkillRegistry;

	constructor(base: AutocompleteProvider, registry: SkillRegistry) {
		this.base = base;
		this.registry = registry;
	}

	setBase(base: AutocompleteProvider): void {
		this.base = base;
	}

	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): { items: AutocompleteItem[]; prefix: string } | null {
		const currentLine = lines[cursorLine] ?? "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		const m = textBeforeCursor.match(SKILL_AUTOCOMPLETE_REGEX);
		if (m) {
			const prefix = m[1] ?? "$";
			const query = prefix.slice(1);

			const candidates = this.registry.getAll().map((s) => ({ name: s.name, description: s.description }));
			const filtered = fuzzyFilter(candidates, query, (c) => c.name).slice(0, 30);
			if (filtered.length === 0) return null;

			return {
				items: filtered.map((c) => ({ value: c.name, label: c.name, description: c.description })),
				prefix,
			};
		}

		return this.base.getSuggestions(lines, cursorLine, cursorCol);
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		if (prefix.startsWith("$")) {
			const currentLine = lines[cursorLine] ?? "";
			const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
			const afterCursor = currentLine.slice(cursorCol);

			const insertion = `$${item.value}`;
			const newLine = beforePrefix + insertion + afterCursor;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + insertion.length,
			};
		}

		return this.base.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
	}
}

class SkillMarkerEditor extends CustomEditor {
	private registry: SkillRegistry;
	private wrapper?: SkillMarkerAutocompleteProvider;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, registry: SkillRegistry) {
		super(tui, theme, keybindings);
		this.registry = registry;
	}

	override setAutocompleteProvider(provider: AutocompleteProvider): void {
		if (!this.wrapper) {
			this.wrapper = new SkillMarkerAutocompleteProvider(provider, this.registry);
		} else {
			this.wrapper.setBase(provider);
		}
		super.setAutocompleteProvider(this.wrapper);
	}

	/**
	 * Auto-trigger $skill autocomplete like pi does for slash commands.
	 *
	 * The base Editor only auto-triggers on '/' and '@'. For '$', we call into the
	 * Editor's internal autocomplete trigger via runtime access.
	 */
	override handleInput(data: string): void {
		super.handleInput(data);

		// Only for single-character inserts (typing). Avoid interfering with navigation keys.
		if (data.length !== 1) return;

		// Only trigger when not already showing suggestions.
		if (this.isShowingAutocomplete()) return;

		// Trigger when typing '$' or continuing a $token.
		if (data !== "$" && !/[a-z0-9-]/.test(data)) return;

		const { line, col } = this.getCursor();
		const currentLine = this.getLines()[line] ?? "";
		const textBeforeCursor = currentLine.slice(0, col);
		if (!textBeforeCursor.match(SKILL_AUTOCOMPLETE_REGEX)) return;

		// Call Editor private method (TS private is runtime-accessible)
		const self = this as unknown as { tryTriggerAutocomplete?: (explicitTab?: boolean) => void };
		self.tryTriggerAutocomplete?.(false);
	}
}

// ============================================================================
// Helpers
// ============================================================================

function collectMentionedSkills(prompt: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const m of prompt.matchAll(SKILL_MARKER_REGEX)) {
		const name = m[1];
		if (!name) continue;
		if (seen.has(name)) continue;
		seen.add(name);
		out.push(name);
	}
	return out;
}

// ============================================================================
// Extension
// ============================================================================

export default function skillMarker(pi: ExtensionAPI) {
	if (!ENABLED) return;

	const registry = new SkillRegistry();

	async function reloadSkills(cwd: string) {
		const agentDir = getAgentDir();
		const settings = loadSettings(cwd, agentDir);
		const { skills } = discoverSkills(cwd, agentDir, settings.skills);
		registry.refresh(skills);
	}

	pi.on("session_start", async (_event, ctx) => {
		try {
			await reloadSkills(ctx.cwd);
		} catch (err) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`skill-marker: failed to discover skills: ${err instanceof Error ? err.message : String(err)}`,
					"warning",
				);
			}
		}

		// Install editor with $skill autocomplete.
		// In non-interactive modes, ui is a no-op.
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new SkillMarkerEditor(tui, theme, keybindings, registry));
	});

	pi.on("before_agent_start", async (event, ctx) => {
		// Ensure registry is populated (best-effort)
		if (registry.getAll().length === 0) {
			try {
				await reloadSkills(ctx.cwd);
			} catch {
				// ignore
			}
		}

		const mentioned = collectMentionedSkills(event.prompt);
		if (mentioned.length === 0) return;

		const blocks: string[] = [];
		const missing: string[] = [];
		const failed: Array<{ name: string; error: string }> = [];

		for (const name of mentioned) {
			const info = registry.get(name);
			if (!info) {
				missing.push(name);
				continue;
			}

			try {
				const body = await registry.getBody(name);
				if (!body) {
					missing.push(name);
					continue;
				}
				let instructions = body.text;
				if (body.truncated) {
					instructions += `\n\n[Skill content truncated; full content at: ${body.path}]`;
				}

				blocks.push(
					[
						"<skill>",
						`<name>${escapeXml(name)}</name>`,
						`<path>${escapeXml(body.path)}</path>`,
						"<instructions>",
						instructions,
						"</instructions>",
						"</skill>",
					].join("\n"),
				);
			} catch (err) {
				failed.push({ name, error: err instanceof Error ? err.message : String(err) });
			}
		}

		if (ctx.hasUI) {
			if (missing.length > 0) {
				ctx.ui.notify(`skill-marker: unknown skill(s): ${missing.join(", ")}`, "warning");
			}
			if (failed.length > 0) {
				ctx.ui.notify(
					`skill-marker: failed to load skill(s): ${failed.map((f) => `${f.name} (${f.error})`).join(", ")}`,
					"warning",
				);
			}
		}

		if (blocks.length === 0) return;

		return {
			message: {
				customType: "skill-marker",
				content: blocks.join("\n\n"),
				display: false,
			},
		};
	});
}

function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
