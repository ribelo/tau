import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@mariozechner/pi-ai";
import { readJsonFile } from "../shared/fs.js";
import { isRecord } from "../shared/json.js";
import {
	type FilesystemMode,
	type NetworkMode,
	APPROVAL_POLICIES,
	FILESYSTEM_MODES,
	NETWORK_MODES,
	migrateApprovalPolicy,
} from "../shared/policy.js";
import type { SandboxConfig } from "../sandbox/config.js";
import type { Complexity, ResolvedPolicy, TaskType } from "./types.js";
import { loadSkill } from "./skills.js";

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

function normalizeComplexityConfig(v: unknown): TaskType["complexity"] | undefined {
	if (!isRecord(v)) return undefined;
	const out: TaskType["complexity"] = {};
	for (const key of ["low", "medium", "high"] as const) {
		const item = v[key];
		if (!isRecord(item)) continue;
		const model = typeof item.model === "string" ? item.model : undefined;
		const thinking = normalizeThinkingLevel(item.thinking);
		if (model || thinking) out[key] = { model, thinking };
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeSandboxConfig(taskType: string, raw: unknown): SandboxConfig | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (!isRecord(raw)) {
		throw new Error(`Task type "${taskType}": sandbox must be an object`);
	}

	const out: SandboxConfig = {};

	if (raw.filesystemMode !== undefined) {
		const v = raw.filesystemMode;
		if (typeof v !== "string") throw new Error(`Task type "${taskType}": sandbox.filesystemMode must be a string`);
		if (!FILESYSTEM_MODES.includes(v as FilesystemMode)) {
			throw new Error(
				`Task type "${taskType}": invalid sandbox.filesystemMode "${v}" (expected ${FILESYSTEM_MODES.join(", ")})`,
			);
		}
		out.filesystemMode = v as FilesystemMode;
	}

	if (raw.networkMode !== undefined) {
		const v = raw.networkMode;
		if (typeof v !== "string") throw new Error(`Task type "${taskType}": sandbox.networkMode must be a string`);
		if (!NETWORK_MODES.includes(v as NetworkMode)) {
			throw new Error(
				`Task type "${taskType}": invalid sandbox.networkMode "${v}" (expected ${NETWORK_MODES.join(", ")})`,
			);
		}
		out.networkMode = v as NetworkMode;
	}

	if (raw.networkAllowlist !== undefined) {
		const v = raw.networkAllowlist;
		if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
			throw new Error(`Task type "${taskType}": sandbox.networkAllowlist must be an array of strings`);
		}
		out.networkAllowlist = (v as string[]).map((x: string) => x.trim()).filter(Boolean);
	}

	if (raw.approvalPolicy !== undefined) {
		const v = raw.approvalPolicy;
		if (typeof v !== "string") throw new Error(`Task type "${taskType}": sandbox.approvalPolicy must be a string`);
		const migrated = migrateApprovalPolicy(v);
		if (!migrated) {
			throw new Error(
				`Task type "${taskType}": invalid sandbox.approvalPolicy "${v}" (expected ${APPROVAL_POLICIES.join(", ")})`,
			);
		}
		out.approvalPolicy = migrated;
	}

	if (raw.approvalTimeoutSeconds !== undefined) {
		const v = raw.approvalTimeoutSeconds;
		if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
			throw new Error(`Task type "${taskType}": sandbox.approvalTimeoutSeconds must be a positive number`);
		}
		out.approvalTimeoutSeconds = Math.floor(v);
	}

	return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeTaskType(name: string, raw: unknown): TaskType | null {
	if (!isRecord(raw)) return null;

	const description = typeof raw.description === "string" ? raw.description : "";
	const tools = Array.isArray(raw.tools) ? raw.tools.filter((t) => typeof t === "string") : undefined;
	const model = typeof raw.model === "string" ? raw.model : undefined;
	const defaultThinking = normalizeThinkingLevel(raw.defaultThinking ?? raw.thinking);
	const skills = Array.isArray(raw.skills) ? raw.skills.filter((s) => typeof s === "string") : undefined;
	const complexity = normalizeComplexityConfig(raw.complexity);
	const sandbox = normalizeSandboxConfig(name, raw.sandbox);

	if (model && complexity) {
		throw new Error(`Task type "${name}" cannot define both model and complexity`);
	}

	return {
		name,
		description,
		tools: tools && tools.length > 0 ? tools : undefined,
		model: complexity ? undefined : model,
		defaultThinking,
		complexity,
		skills: skills && skills.length > 0 ? skills : undefined,
		sandbox,
	};
}

function mergeTaskType(base: TaskType, override: TaskType): TaskType {
	const mergedComplexity = {
		...(base.complexity ?? {}),
		...(override.complexity ?? {}),
	};
	const hasComplexity = Object.keys(mergedComplexity).length > 0;

	return {
		...base,
		...override,
		// arrays replace, but normalize to undefined if empty
		tools: override.tools !== undefined ? (override.tools.length > 0 ? override.tools : undefined) : base.tools,
		skills: override.skills !== undefined ? (override.skills.length > 0 ? override.skills : undefined) : base.skills,
		complexity: hasComplexity ? mergedComplexity : undefined,
		model: hasComplexity ? undefined : override.model ?? base.model,
		sandbox: override.sandbox !== undefined ? { ...(base.sandbox ?? {}), ...(override.sandbox ?? {}) } : base.sandbox,
	};
}

function resolveComplexityConfig(complexityConfig: TaskType["complexity"], complexity: Complexity) {
	const order: Complexity[] = ["low", "medium", "high"];
	const start = order.indexOf(complexity);
	if (start === -1) return undefined;

	for (let i = start; i < order.length; i++) {
		const candidate = complexityConfig?.[order[i]];
		if (candidate) return candidate;
	}

	for (let i = start - 1; i >= 0; i--) {
		const candidate = complexityConfig?.[order[i]];
		if (candidate) return candidate;
	}

	return undefined;
}

type TaskRegistryLoadOptions = {
	knownTools?: string[];
	validateSkills?: boolean;
};

function validateTaskTypeConfigs(taskTypes: TaskType[], cwd: string, options: TaskRegistryLoadOptions): void {
	const unknownTools: string[] = [];
	const unknownSkills: string[] = [];
	const toolSet = options.knownTools ? new Set(options.knownTools.map((t) => t.trim()).filter(Boolean)) : undefined;

	for (const task of taskTypes) {
		if (toolSet && task.tools) {
			const missing = task.tools.filter((tool) => !toolSet.has(tool));
			if (missing.length > 0) {
				unknownTools.push(`${task.name}: ${missing.join(", ")}`);
			}
		}

		if (options.validateSkills && task.skills) {
			const missingSkills = task.skills.filter((skill) => !loadSkill(skill, cwd));
			if (missingSkills.length > 0) {
				unknownSkills.push(`${task.name}: ${missingSkills.join(", ")}`);
			}
		}
	}

	const errors: string[] = [];
	if (unknownTools.length > 0) {
		errors.push(`Unknown tools in task config: ${unknownTools.join("; ")}`);
	}
	if (unknownSkills.length > 0) {
		errors.push(`Unknown skills in task config: ${unknownSkills.join("; ")}`);
	}
	if (errors.length > 0) {
		throw new Error(errors.join("\n"));
	}
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
				description: "Edit files, implement features, fix bugs. Use when you need to change code.",
				tools: undefined, // all
				model: "inherit",
				skills: ["code"],
			},
			{
				name: "search",
				description: "Find files, locate code patterns, map codebase. Use before you know what to change.",
				tools: ["read", "bash"],
				model: "inherit",
				skills: ["search"],
			},
			{
				name: "review",
				description: "Review diffs for bugs/security. Returns structured JSON. Use for PR/commit review.",
				tools: ["read", "bash"],
				model: "inherit",
				skills: ["review"],
			},
			{
				name: "planning",
				description: "Design solutions, create implementation plans. Use before complex changes.",
				tools: ["read", "bash"],
				model: "inherit",
				skills: ["planning"],
			},
			{
				name: "advisor",
				description: "Senior engineer advisor for hard problems. Use when you need expert guidance.",
				tools: ["read", "bash"],
				model: "inherit",
				skills: ["advisor", "simplicity", "analysis"],
			},
			{
				name: "refactor",
				description: "Rename, transform code across files. Use ast-grep/fastmod for structural changes.",
				tools: undefined, // all
				model: "inherit",
				skills: ["ast-grep", "fastmod"],
			},
			{
				name: "bash",
				description: "Run commands, install deps, build, scripts. Use for system operations not code changes.",
				tools: ["bash", "read"],
				model: "inherit",
				skills: ["bash"],
			},
			{
				name: "custom",
				description: "Ad-hoc worker with skills you specify. Use when you need specific skill combination.",
				tools: undefined, // all
				model: "inherit",
				skills: [],
			},
		];
	}

	static load(cwd: string, options: TaskRegistryLoadOptions = {}): TaskRegistry {
		const merged = new Map<string, TaskType>();
		for (const t of TaskRegistry.builtins()) merged.set(t.name, t);

		const applySettings = (settingsPath: string) => {
			const json = readJsonFile(settingsPath);
			if (!json) return;
			const tasks = json.tasks;
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

		const taskTypes = Array.from(merged.values());
		if (options.knownTools || options.validateSkills) {
			validateTaskTypeConfigs(taskTypes, cwd, options);
		}

		return new TaskRegistry(taskTypes);
	}

	get(taskType: string): TaskType | undefined {
		return this.types.get(taskType);
	}

	list(): TaskType[] {
		return Array.from(this.types.values()).sort((a, b) => a.name.localeCompare(b.name));
	}

	resolve(taskType: string, complexity: Complexity): ResolvedPolicy {
		const t = this.get(taskType);
		if (!t) throw new Error(`Unknown task type: ${taskType}`);

		const complexityConfig = t.complexity ? resolveComplexityConfig(t.complexity, complexity) : undefined;
		const modelCandidate = complexityConfig?.model ?? t.model;
		const model =
			typeof modelCandidate === "string" && modelCandidate.trim().length > 0 && modelCandidate !== "inherit"
				? modelCandidate
				: undefined;
		const thinking = complexityConfig?.thinking ?? t.defaultThinking;

		return {
			taskType: t.name,
			complexity,
			model,
			thinking,
			tools: t.tools,
			skills: (t.skills ?? []).slice(),
			sandbox: t.sandbox
				? {
						...t.sandbox,
						networkAllowlist: t.sandbox.networkAllowlist ? t.sandbox.networkAllowlist.slice() : undefined,
					}
				: undefined,
		};
	}
}
