import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type SlashCommandInfo,
	getAgentDir,
	loadSkills,
	stripFrontmatter,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import type { AutocompleteProvider } from "@mariozechner/pi-tui";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { SkillMarkerAutocompleteProvider, type SkillCandidate } from "./autocomplete.js";
import { findNearestWorkspaceRoot } from "../shared/discovery.js";

// Re-export for use by editor
export { shouldAutoTriggerSkillAutocomplete } from "./autocomplete.js";

const ENABLED = true;
const __dirname = dirname(fileURLToPath(import.meta.url));
const TAU_SKILLS_DIR = join(__dirname, "..", "..", "skills");

// Marker rules (see tau-2lq.1)
const SKILL_MARKER_REGEX = /(?:^|\s)\$([a-z0-9][a-z0-9-]*)(?=$|[^a-z0-9-])/g;

type SkillInfo = {
	name: string;
	description: string;
	path: string;
};

type SkillBody = {
	path: string;
	text: string;
	truncated: boolean;
};

class SkillRegistry {
	private byName = new Map<string, SkillInfo>();
	private bodyCache = new Map<string, SkillBody>();

	refresh(skills: Iterable<SkillInfo>): void {
		this.byName.clear();
		for (const s of skills) {
			this.byName.set(s.name, {
				name: s.name,
				description: s.description,
				path: s.path,
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
		const truncation = truncateHead(body, {
			maxBytes: DEFAULT_MAX_BYTES,
			maxLines: DEFAULT_MAX_LINES,
		});

		const result: SkillBody = {
			path: info.path,
			text: truncation.content,
			truncated: truncation.truncated,
		};
		this.bodyCache.set(name, result);
		return result;
	}
}

function getSkillInfoFromCommands(commands: readonly SlashCommandInfo[]): SkillInfo[] {
	const skills: SkillInfo[] = [];

	for (const command of commands) {
		if (command.source !== "skill") continue;
		if (!command.name.startsWith("skill:")) continue;

		const name = command.name.slice("skill:".length);
		if (name.length === 0) continue;

		if (!command.sourceInfo?.path) continue;

		skills.push({
			name,
			description: command.description ?? "",
			path: command.sourceInfo.path,
		});
	}

	return skills;
}

export type SkillMarkerRuntime = {
	registry: SkillRegistry;
	wrapper?: SkillMarkerAutocompleteProvider;
};

export function createSkillMarkerRuntime(): SkillMarkerRuntime {
	return { registry: new SkillRegistry() };
}

function pushUniquePath(paths: string[], candidate: string): void {
	const normalized = resolve(candidate);
	if (!paths.includes(normalized)) {
		paths.push(normalized);
	}
}

function getAncestorAgentsSkillDirs(cwd: string, stopAt: string): ReadonlyArray<string> {
	const roots: string[] = [];
	const resolvedStopAt = resolve(stopAt);
	let current = resolve(cwd);
	for (;;) {
		pushUniquePath(roots, join(current, ".agents", "skills"));
		if (current === resolvedStopAt) {
			break;
		}
		const parent = dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}
	return roots;
}

function getExtraSkillPaths(cwd: string, agentDir: string): ReadonlyArray<string> {
	const paths: string[] = [];
	const resolvedCwd = resolve(cwd);
	const workspaceRoot = findNearestWorkspaceRoot(resolvedCwd);

	pushUniquePath(paths, join(resolvedCwd, ".pi", "skills"));
	pushUniquePath(paths, join(workspaceRoot, ".pi", "skills"));
	pushUniquePath(paths, join(resolvedCwd, "skills"));
	pushUniquePath(paths, join(workspaceRoot, "skills"));
	for (const root of getAncestorAgentsSkillDirs(resolvedCwd, workspaceRoot)) {
		pushUniquePath(paths, root);
	}
	pushUniquePath(paths, TAU_SKILLS_DIR);
	pushUniquePath(paths, join(agentDir, "skills"));
	pushUniquePath(paths, join(homedir(), ".agents", "skills"));

	return paths;
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
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function refreshFromActiveCommands(pi: ExtensionAPI, runtime: SkillMarkerRuntime): void {
	const skills = getSkillInfoFromCommands(pi.getCommands());
	if (skills.length === 0) return;
	runtime.registry.refresh(skills);
}

export async function reloadSkills(runtime: SkillMarkerRuntime, cwd: string) {
	const agentDir = getAgentDir();
	const { skills } = loadSkills({
		cwd,
		agentDir,
		includeDefaults: false,
		skillPaths: [...getExtraSkillPaths(cwd, agentDir)],
	});
	runtime.registry.refresh(
		skills.map((skill) => ({
			name: skill.name,
			description: skill.description,
			path: skill.filePath,
		})),
	);
}

async function refreshSkillRegistry(pi: ExtensionAPI, runtime: SkillMarkerRuntime, cwd: string) {
	refreshFromActiveCommands(pi, runtime);
	if (runtime.registry.getAllNames().length > 0) return;
	await reloadSkills(runtime, cwd);
}

export function wrapAutocompleteProvider(
	runtime: SkillMarkerRuntime,
	provider: AutocompleteProvider,
): AutocompleteProvider {
	if (!runtime.wrapper) {
		runtime.wrapper = new SkillMarkerAutocompleteProvider(provider, () =>
			runtime.registry.getCandidates(),
		);
	} else {
		runtime.wrapper.setBase(provider);
	}
	return runtime.wrapper as unknown as AutocompleteProvider;
}

export default function initSkillMarker(pi: ExtensionAPI, runtime: SkillMarkerRuntime) {
	if (!ENABLED) return;

	pi.on("session_start", async (_event, ctx) => {
		try {
			await refreshSkillRegistry(pi, runtime, ctx.cwd);
			setTimeout(() => {
				try {
					refreshFromActiveCommands(pi, runtime);
				} catch {
					// ignore delayed refresh failures
				}
			}, 0);
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
		try {
			await refreshSkillRegistry(pi, runtime, ctx.cwd);
		} catch {
			// ignore
		}

		const mentioned = collectMentionedSkills(event.prompt);
		if (mentioned.length === 0) return;

		const blocks: string[] = [];
		const missing: string[] = [];
		const failed: Array<{ name: string; error: string }> = [];

		for (const name of mentioned) {
			if (!runtime.registry.get(name)) {
				missing.push(name);
				continue;
			}

			try {
				const body = await runtime.registry.getBody(name);
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
