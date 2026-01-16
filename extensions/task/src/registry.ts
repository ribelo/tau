import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@mariozechner/pi-ai";
import type { Difficulty, ResolvedPolicy, TaskType } from "./types.js";

type AnyRecord = Record<string, unknown>;

function isRecord(v: unknown): v is AnyRecord {
	return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function readJsonFile(filePath: string): AnyRecord | null {
	try {
		const text = fs.readFileSync(filePath, "utf-8");
		const json = JSON.parse(text) as unknown;
		return isRecord(json) ? json : null;
	} catch {
		return null;
	}
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectSettings(cwd: string): string | null {
	let current = cwd;
	while (true) {
		const candidate = path.join(current, ".pi", "settings.json");
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function normalizeThinkingLevel(level: unknown): ThinkingLevel | undefined {
	if (typeof level !== "string") return undefined;
	const v = level.trim().toLowerCase();
	if (!v) return undefined;
	if (v === "xhigh") return "high";
	if (v === "none") return "off";
	if (v === "min") return "minimal";
	if (v === "med") return "medium";
	if (v === "max") return "high";
	if (v === "off" || v === "minimal" || v === "low" || v === "medium" || v === "high") return v;
	return undefined;
}

function normalizeDifficultyConfig(v: unknown): TaskType["difficulty"] | undefined {
	if (!isRecord(v)) return undefined;
	const out: TaskType["difficulty"] = {};
	for (const key of ["small", "medium", "large"] as const) {
		const item = (v as any)[key];
		if (!isRecord(item)) continue;
		const model = typeof item.model === "string" ? item.model : undefined;
		const thinking = normalizeThinkingLevel(item.thinking);
		if (model || thinking) out[key] = { model, thinking };
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeTaskType(name: string, raw: unknown): TaskType | null {
	if (!isRecord(raw)) return null;

	const description = typeof raw.description === "string" ? raw.description : "";
	const tools = Array.isArray(raw.tools) ? raw.tools.filter((t) => typeof t === "string") : undefined;
	const defaultModel = typeof raw.defaultModel === "string" ? raw.defaultModel : (typeof (raw as any).model === "string" ? (raw as any).model : undefined);
	const defaultThinking = normalizeThinkingLevel((raw as any).defaultThinking ?? (raw as any).thinking);
	const skills = Array.isArray(raw.skills) ? raw.skills.filter((s) => typeof s === "string") : undefined;
	const difficulty = normalizeDifficultyConfig((raw as any).difficulty);

	return {
		name,
		description,
		tools: tools && tools.length > 0 ? tools : undefined,
		defaultModel,
		defaultThinking,
		difficulty,
		skills: skills && skills.length > 0 ? skills : undefined,
	};
}

function mergeTaskType(base: TaskType, override: TaskType): TaskType {
	return {
		...base,
		...override,
		// arrays replace, but normalize to undefined if empty
		tools: override.tools !== undefined ? (override.tools.length > 0 ? override.tools : undefined) : base.tools,
		skills: override.skills !== undefined ? (override.skills.length > 0 ? override.skills : undefined) : base.skills,
		difficulty: {
			...(base.difficulty ?? {}),
			...(override.difficulty ?? {}),
		},
	};
}

export class TaskRegistry {
	private readonly types = new Map<string, TaskType>();

	constructor(taskTypes: TaskType[]) {
		for (const t of taskTypes) {
			this.types.set(t.name, t);
		}
	}

	static builtins(): TaskType[] {
		return [
			{
				name: "code",
				description: "General implementation work",
				tools: undefined, // all
				defaultModel: "inherit",
				skills: [],
			},
			{
				name: "search",
				description: "Find code, definitions, references (read-only)",
				tools: ["read", "ls", "find", "grep"],
				defaultModel: "inherit",
				skills: ["search"],
			},
			{
				name: "review",
				description: "Code review (read-only + bash)",
				tools: ["read", "ls", "find", "grep", "bash"],
				defaultModel: "inherit",
				skills: ["review"],
			},
			{
				name: "planning",
				description: "Architecture and design decisions (read-only)",
				tools: ["read", "ls", "find", "grep"],
				defaultModel: "inherit",
				skills: ["planning"],
			},
			{
				name: "general",
				description: "General task with user-specified skills",
				tools: undefined, // all
				defaultModel: "inherit",
				skills: [],
			},
		];
	}

	static load(cwd: string): TaskRegistry {
		const merged = new Map<string, TaskType>();
		for (const t of TaskRegistry.builtins()) merged.set(t.name, t);

		const applySettings = (settingsPath: string) => {
			const json = readJsonFile(settingsPath);
			if (!json) return;
			const tasks = (json as any).tasks;
			if (!isRecord(tasks)) return;

			for (const [name, rawTask] of Object.entries(tasks)) {
				const normalized = normalizeTaskType(name, rawTask);
				if (!normalized) continue;
				const existing = merged.get(name);
				merged.set(name, existing ? mergeTaskType(existing, normalized) : normalized);
			}
		};

		// Global settings first (lower priority)
		const globalSettings = path.join(os.homedir(), ".pi", "agent", "settings.json");
		if (fs.existsSync(globalSettings)) applySettings(globalSettings);

		// Project settings last (higher priority)
		const projectSettings = findNearestProjectSettings(cwd);
		if (projectSettings && fs.existsSync(projectSettings)) applySettings(projectSettings);

		return new TaskRegistry(Array.from(merged.values()));
	}

	get(taskType: string): TaskType | undefined {
		return this.types.get(taskType);
	}

	list(): TaskType[] {
		return Array.from(this.types.values()).sort((a, b) => a.name.localeCompare(b.name));
	}

	resolve(taskType: string, difficulty: Difficulty): ResolvedPolicy {
		const t = this.get(taskType);
		if (!t) throw new Error(`Unknown task type: ${taskType}`);

		const diff = t.difficulty?.[difficulty];
		const modelCandidate = diff?.model ?? t.defaultModel;
		const model = typeof modelCandidate === "string" && modelCandidate.trim().length > 0 && modelCandidate !== "inherit" ? modelCandidate : undefined;
		const thinking = diff?.thinking ?? t.defaultThinking;

		return {
			taskType: t.name,
			difficulty,
			model,
			thinking,
			tools: t.tools,
			skills: (t.skills ?? []).slice(),
		};
	}
}
