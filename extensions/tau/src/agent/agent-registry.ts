/**
 * AgentRegistry - discovers and loads agent definitions from .md files.
 *
 * Search paths (in priority order):
 * 1. Project: .pi/agents/*.md
 * 2. User: ~/.pi/agent/agents/*.md
 * 3. Extension: extensions/tau/agents/*.md (bundled)
 *
 * NOTE: Mode agents (smart/deep/rush) are virtual and derive model+thinking from
 * prompt mode settings (global/project). They are not loadable/overridable via
 * agent frontmatter.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

import { readJsonFile } from "../shared/fs.js";
import { isRecord } from "../shared/json.js";
import { resolvePromptModePresets, type PromptModeName, isPromptModeName } from "../prompt/modes.js";
import type { SandboxConfig } from "../sandbox/config.js";
import { parseAgentDefinition } from "./parser.js";
import type { AgentDefinition, Complexity, ModelSpec } from "./types.js";

const EXTENSION_AGENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "agents");

const MODE_AGENT_SANDBOX: SandboxConfig = {
	filesystemMode: "workspace-write",
	networkMode: "allow-all",
	approvalPolicy: "never",
	approvalTimeoutSeconds: 60,
};

function buildModeAgentDefinition(mode: PromptModeName, cwd: string): AgentDefinition {
	const presets = resolvePromptModePresets(cwd);
	const preset = presets[mode];

	const model: ModelSpec = { model: preset.model, thinking: preset.thinking as ThinkingLevel };

	const description =
		mode === "smart"
			? "Smart agent. Uses the smart mode system prompt and preset model selection."
			: mode === "deep"
				? "Deep agent. Uses the deep mode system prompt and preset model selection."
				: "Rush agent. Uses the rush mode system prompt and preset model selection.";

	return {
		name: mode,
		description,
		models: [model],
		sandbox: MODE_AGENT_SANDBOX,
		systemPrompt: "",
	};
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function isFile(p: string): boolean {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

function findNearestProjectPiDir(cwd: string): string | null {
	let current = cwd;
	for (;;) {
		const candidate = path.join(current, ".pi");
		if (isDirectory(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function discoverAgentFiles(dir: string): Map<string, string> {
	const result = new Map<string, string>();
	if (!isDirectory(dir)) return result;

	try {
		const files = fs.readdirSync(dir);
		for (const file of files) {
			if (!file.endsWith(".md")) continue;
			const name = file.slice(0, -3);
			if (isPromptModeName(name)) {
				// Mode agents are virtual; ignore any .md override.
				continue;
			}
			const filePath = path.join(dir, file);
			if (isFile(filePath)) result.set(name, filePath);
		}
	} catch {
		// ignore
	}

	return result;
}

const THINKING_LEVELS = new Set<ThinkingLevel | "inherit">(["low", "medium", "high", "inherit"]);

function parseModelsArray(arr: unknown): ModelSpec[] | undefined {
	if (!Array.isArray(arr)) return undefined;
	const result: ModelSpec[] = [];
	for (const entry of arr) {
		if (!isRecord(entry)) continue;
		const model = entry["model"];
		if (typeof model !== "string") continue;
		const spec: ModelSpec = { model };
		const thinking = entry["thinking"];
		if (typeof thinking === "string" && THINKING_LEVELS.has(thinking as ThinkingLevel | "inherit")) {
			(spec as { thinking?: string }).thinking = thinking;
		}
		result.push(spec);
	}
	return result.length > 0 ? result : undefined;
}

interface ComplexityConfig {
	models?: readonly ModelSpec[];
}

interface AgentSettingsOverride {
	models?: readonly ModelSpec[];
	complexity?: {
		low?: ComplexityConfig;
		medium?: ComplexityConfig;
		high?: ComplexityConfig;
	};
}

function findNearestProjectSettings(cwd: string): string | null {
	let current = cwd;
	for (;;) {
		const candidate = path.join(current, ".pi", "settings.json");
		if (isFile(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function loadAgentSettings(cwd: string): Map<string, AgentSettingsOverride> {
	const result = new Map<string, AgentSettingsOverride>();

	const applySettings = (settingsPath: string) => {
		const json = readJsonFile(settingsPath);
		if (!json) return;
		const agents = json["agents"];
		if (!isRecord(agents)) return;

		for (const [name, config] of Object.entries(agents)) {
			if (isPromptModeName(name)) {
				// Mode agents are configured via promptModes settings, not agents settings.
				continue;
			}
			if (!isRecord(config)) continue;

			const override: AgentSettingsOverride = {};
			const models = parseModelsArray(config["models"]);
			if (models) override.models = models;

			const complexity = config["complexity"];
			if (isRecord(complexity)) {
				override.complexity = {};
				for (const level of ["low", "medium", "high"] as const) {
					const levelConfig = complexity[level];
					if (!isRecord(levelConfig)) continue;
					const levelModels = parseModelsArray(levelConfig["models"]);
					if (levelModels) {
						override.complexity[level] = { models: levelModels };
					}
				}
				if (Object.keys(override.complexity).length === 0) delete override.complexity;
			}

			if (Object.keys(override).length > 0) {
				const existing = result.get(name);
				result.set(name, existing ? { ...existing, ...override } : override);
			}
		}
	};

	const globalSettings = path.join(os.homedir(), ".pi", "agent", "settings.json");
	if (isFile(globalSettings)) applySettings(globalSettings);

	const projectSettings = findNearestProjectSettings(cwd);
	if (projectSettings) applySettings(projectSettings);

	return result;
}

export interface AgentSummary {
	readonly name: string;
	readonly description: string;
}

export class AgentRegistry {
	private readonly agentPaths: Map<string, string>;
	private readonly settingsOverrides: Map<string, AgentSettingsOverride>;
	private readonly cache: Map<string, AgentDefinition>;
	private readonly modeAgents: Map<PromptModeName, AgentDefinition>;
	private readonly cwd: string;

	private constructor(args: {
		agentPaths: Map<string, string>;
		settingsOverrides: Map<string, AgentSettingsOverride>;
		modeAgents: Map<PromptModeName, AgentDefinition>;
		cwd: string;
	}) {
		this.agentPaths = args.agentPaths;
		this.settingsOverrides = args.settingsOverrides;
		this.modeAgents = args.modeAgents;
		this.cwd = args.cwd;
		this.cache = new Map();
	}

	static load(cwd: string): AgentRegistry {
		const merged = new Map<string, string>();

		for (const [name, filePath] of discoverAgentFiles(EXTENSION_AGENTS_DIR)) {
			merged.set(name, filePath);
		}

		const userAgentsDir = path.join(os.homedir(), ".pi", "agent", "agents");
		for (const [name, filePath] of discoverAgentFiles(userAgentsDir)) {
			merged.set(name, filePath);
		}

		const projectPi = findNearestProjectPiDir(cwd);
		if (projectPi) {
			const projectAgentsDir = path.join(projectPi, "agents");
			for (const [name, filePath] of discoverAgentFiles(projectAgentsDir)) {
				merged.set(name, filePath);
			}
		}

		const modeAgents = new Map<PromptModeName, AgentDefinition>();
		for (const mode of ["smart", "deep", "rush"] as const) {
			modeAgents.set(mode, buildModeAgentDefinition(mode, cwd));
		}

		return new AgentRegistry({
			agentPaths: merged,
			settingsOverrides: loadAgentSettings(cwd),
			modeAgents,
			cwd,
		});
	}

	get(name: string): AgentDefinition | undefined {
		if (isPromptModeName(name)) {
			return this.modeAgents.get(name);
		}

		const cached = this.cache.get(name);
		if (cached) return cached;

		const filePath = this.agentPaths.get(name);
		if (!filePath) return undefined;

		try {
			const content = fs.readFileSync(filePath, "utf-8");
			const definition = parseAgentDefinition(content);
			this.cache.set(name, definition);
			return definition;
		} catch {
			return undefined;
		}
	}

	has(name: string): boolean {
		return isPromptModeName(name) ? this.modeAgents.has(name) : this.agentPaths.has(name);
	}

	names(): string[] {
		const names = new Set<string>([...this.agentPaths.keys(), ...this.modeAgents.keys()]);
		return Array.from(names).sort();
	}

	list(): AgentSummary[] {
		return this.names().map((name) => {
			const def = this.get(name);
			return { name, description: def?.description ?? "" };
		});
	}

	resolve(name: string, complexity: Complexity): AgentDefinition | undefined {
		if (isPromptModeName(name)) {
			// Mode agents ignore agent-level overrides; use prompt mode settings.
			return buildModeAgentDefinition(name, this.cwd);
		}

		const def = this.get(name);
		if (!def) return undefined;

		const override = this.settingsOverrides.get(name);
		if (!override) return def;

		let models = def.models;
		if (override.models) models = override.models;

		const complexityConfig = override.complexity?.[complexity];
		if (complexityConfig?.models) {
			models = complexityConfig.models;
		}

		return { ...def, models };
	}
}
