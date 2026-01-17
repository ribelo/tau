import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	discoverSkills,
	getAgentDir,
	loadSettings,
	stripFrontmatter,
	truncateHead,
	type Skill,
} from "@mariozechner/pi-coding-agent";
import type { AutocompleteProvider } from "@mariozechner/pi-tui";
import { readFile } from "node:fs/promises";

import { registerEditorPlugin } from "../../editor-hub/src/registry.js";
import {
	SkillMarkerAutocompleteProvider,
	shouldAutoTriggerSkillAutocomplete,
	type SkillCandidate,
} from "./autocomplete.js";

/**
 * skill-marker
 *
 * Codex-inspired behavior:
 * - `$skillname` stays in the user prompt (marker)
 * - Inject a separate `<skill>...</skill>` message before the model is called
 *
 * Autocomplete integration:
 * - This extension does NOT call ctx.ui.setEditorComponent().
 * - It registers an editor-hub plugin to add $skill autocomplete to whichever editor is active.
 */

const ENABLED = true;

// Marker rules (see tau-2lq.1)
const SKILL_MARKER_REGEX = /(?:^|\s)\$([a-z0-9][a-z0-9-]*)(?=$|[^a-z0-9-])/g;

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

	get(name: string): SkillInfo | undefined {
		return this.byName.get(name);
	}

	getCandidates(): SkillCandidate[] {
		return [...this.byName.values()].map((s) => ({ name: s.name, description: s.description }));
	}

	getAllNames(): string[] {
		return [...this.byName.keys()];
	}

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

function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export default function skillMarker(pi: ExtensionAPI) {
	if (!ENABLED) return;

	const registry = new SkillRegistry();

	async function reloadSkills(cwd: string) {
		const agentDir = getAgentDir();
		const settings = loadSettings(cwd, agentDir);
		const { skills } = discoverSkills(cwd, agentDir, settings.skills);
		registry.refresh(skills);
	}

	// Editor plugin: adds $skill autocomplete without owning the editor
	let wrapper: SkillMarkerAutocompleteProvider | undefined;
	registerEditorPlugin({
		id: "skill-marker:autocomplete",
		priority: 50,
		wrapAutocompleteProvider: (provider: AutocompleteProvider, editor: any) => {
			if (!wrapper) {
				wrapper = new SkillMarkerAutocompleteProvider(provider, () => registry.getCandidates());
			} else {
				wrapper.setBase(provider);
			}
			return wrapper;
		},
		afterInput: (data: string, editor: any) => {
			if (!shouldAutoTriggerSkillAutocomplete(editor, data)) return;
			const self = editor as unknown as { tryTriggerAutocomplete?: (explicitTab?: boolean) => void };
			self.tryTriggerAutocomplete?.(false);
		},
	});

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
	});

	pi.on("before_agent_start", async (event, ctx) => {
		// Best-effort: ensure we have skills loaded
		if (registry.getAllNames().length === 0) {
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
			if (!registry.get(name)) {
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
