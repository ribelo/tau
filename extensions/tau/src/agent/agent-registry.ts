/**
 * AgentRegistry - discovers and loads agent definitions from .md files
 * 
 * Search paths (in priority order):
 * 1. Project: .pi/agents/*.md
 * 2. User: ~/.pi/agent/agents/*.md
 * 3. Extension: extensions/tau/agents/*.md (bundled)
 * 
 * Settings overrides (in .pi/settings.json or ~/.pi/agent/settings.json):
 * ```json
 * {
 *   "agents": {
 *     "rush": {
 *       "models": [
 *         { "model": "google-gemini-cli/gemini-3-flash-preview", "thinking": "high" },
 *         { "model": "groq/llama-4-scout", "thinking": "medium" }
 *       ],
 *       "complexity": {
 *         "low": {
 *           "models": [
 *             { "model": "groq/llama-4-scout" },
 *             { "model": "anthropic/claude-haiku-4-5" }
 *           ]
 *         }
 *       }
 *     }
 *   }
 * }
 * ```
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { AgentDefinition, ModelSpec, Complexity } from "./types.js";
import { parseAgentDefinition } from "./parser.js";
import { readJsonFile } from "../shared/fs.js";
import { isRecord } from "../shared/json.js";

const EXTENSION_AGENTS_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"agents",
);

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
	while (true) {
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
			const filePath = path.join(dir, file);
			if (isFile(filePath)) {
				result.set(name, filePath);
			}
		}
	} catch {
		// Ignore read errors
	}

	return result;
}

function parseModelsArray(arr: unknown): ModelSpec[] | undefined {
	if (!Array.isArray(arr)) return undefined;
	const result: ModelSpec[] = [];
	for (const entry of arr) {
		if (!isRecord(entry)) continue;
		const model = entry["model"];
		if (typeof model !== "string") continue;
		const spec: ModelSpec = { model };
		const thinking = entry["thinking"];
		if (typeof thinking === "string") {
			(spec as { thinking?: string }).thinking = thinking as ThinkingLevel;
		}
		result.push(spec);
	}
	return result.length > 0 ? result : undefined;
}

/** Per-complexity override */
interface ComplexityConfig {
	models?: readonly ModelSpec[];
}

/** Settings override for an agent */
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
	while (true) {
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
			if (!isRecord(config)) continue;
			
			const override: AgentSettingsOverride = {};
			
			const models = parseModelsArray(config["models"]);
			if (models) {
				override.models = models;
			}
			
			const complexity = config["complexity"];
			if (isRecord(complexity)) {
				override.complexity = {};
				for (const level of ["low", "medium", "high"] as const) {
					const levelConfig = complexity[level];
					if (isRecord(levelConfig)) {
						const levelModels = parseModelsArray(levelConfig["models"]);
						if (levelModels) {
							override.complexity[level] = { models: levelModels };
						}
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

	// Global settings first (lower priority)
	const globalSettings = path.join(os.homedir(), ".pi", "agent", "settings.json");
	if (isFile(globalSettings)) applySettings(globalSettings);

	// Project settings last (higher priority)
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

	private constructor(
		agentPaths: Map<string, string>,
		settingsOverrides: Map<string, AgentSettingsOverride>,
	) {
		this.agentPaths = agentPaths;
		this.settingsOverrides = settingsOverrides;
		this.cache = new Map();
	}

	static load(cwd: string): AgentRegistry {
		const merged = new Map<string, string>();

		// 1. Extension agents (lowest priority)
		for (const [name, filePath] of discoverAgentFiles(EXTENSION_AGENTS_DIR)) {
			merged.set(name, filePath);
		}

		// 2. User agents (medium priority)
		const userAgentsDir = path.join(os.homedir(), ".pi", "agent", "agents");
		for (const [name, filePath] of discoverAgentFiles(userAgentsDir)) {
			merged.set(name, filePath);
		}

		// 3. Project agents (highest priority)
		const projectPi = findNearestProjectPiDir(cwd);
		if (projectPi) {
			const projectAgentsDir = path.join(projectPi, "agents");
			for (const [name, filePath] of discoverAgentFiles(projectAgentsDir)) {
				merged.set(name, filePath);
			}
		}

		const settingsOverrides = loadAgentSettings(cwd);
		return new AgentRegistry(merged, settingsOverrides);
	}

	get(name: string): AgentDefinition | undefined {
		const cached = this.cache.get(name);
		if (cached) return cached;

		const filePath = this.agentPaths.get(name);
		if (!filePath) return undefined;

		try {
			const content = fs.readFileSync(filePath, "utf-8");
			const definition = parseAgentDefinition(content);
			this.cache.set(name, definition);
			return definition;
		} catch (err) {
			console.error(`Failed to load agent "${name}" from ${filePath}:`, err);
			return undefined;
		}
	}

	has(name: string): boolean {
		return this.agentPaths.has(name);
	}

	names(): string[] {
		return Array.from(this.agentPaths.keys()).sort();
	}

	list(): AgentSummary[] {
		return this.names().map((name) => {
			const def = this.get(name);
			return {
				name,
				description: def?.description ?? "",
			};
		});
	}

	/**
	 * Resolve an agent for spawning with complexity-based model routing.
	 * 
	 * Priority (highest to lowest):
	 * 1. settings.json complexity-specific override
	 * 2. settings.json agent-level override
	 * 3. Agent .md file definition
	 */
	resolve(name: string, complexity: Complexity): AgentDefinition | undefined {
		const def = this.get(name);
		if (!def) return undefined;

		const override = this.settingsOverrides.get(name);
		if (!override) return def;

		// Start with base definition
		let models = def.models;

		// Apply agent-level override
		if (override.models) models = override.models;

		// Apply complexity-specific override (highest priority)
		const complexityConfig = override.complexity?.[complexity];
		if (complexityConfig?.models) {
			models = complexityConfig.models;
		}

		return { ...def, models };
	}
}
