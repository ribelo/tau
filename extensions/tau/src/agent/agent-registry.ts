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
import * as path from "node:path";

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

import { readJsonFileDetailed } from "../shared/fs.js";
import { isRecord } from "../shared/json.js";
import {
	EXTENSION_AGENTS_DIR,
	findNearestProjectPiDir,
	getUserAgentsDir,
	getUserSettingsPath,
} from "../shared/discovery.js";
import {
	resolvePromptModePresets,
	type PromptModeName,
	isPromptModeName,
} from "../prompt/modes.js";
import type { SandboxConfig } from "../sandbox/config.js";
import { parseAgentDefinition } from "./parser.js";
import type { AgentDefinition, Complexity, ModelSpec } from "./types.js";

const MODE_AGENT_SANDBOX: SandboxConfig = {
	preset: "full-access",
};

const THINKING_LEVELS = new Set<ThinkingLevel | "inherit">([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"inherit",
]);

const COMPLEXITY_LEVELS = ["low", "medium", "high"] as const;
const ALLOWED_AGENT_SETTINGS_KEYS = new Set(["models", "complexity"]);
const ALLOWED_COMPLEXITY_CONFIG_KEYS = new Set(["models"]);

export class AgentRegistryConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgentRegistryConfigError";
	}
}

function buildModeAgentDefinition(mode: PromptModeName, cwd: string): AgentDefinition {
	const presets = resolvePromptModePresets(cwd);
	const preset = presets[mode];

	const model: ModelSpec = {
		model: preset.model,
		thinking: preset.thinking as ThinkingLevel,
	};

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
		// Keep mode agents aligned with /mode behavior: use the same mode prompt markdown.
		systemPrompt: preset.systemPrompt,
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

function discoverAgentFiles(dir: string): Map<string, string> {
	const result = new Map<string, string>();
	if (!isDirectory(dir)) return result;

	const files = fs.readdirSync(dir);
	for (const file of files) {
		if (!file.endsWith(".md")) continue;
		const name = file.slice(0, -3);
		if (isPromptModeName(name)) {
			throw new AgentRegistryConfigError(
				`Invalid agent file ${path.join(dir, file)}: mode agents (smart, deep, rush) are virtual and cannot be defined as .md files.`,
			);
		}
		const filePath = path.join(dir, file);
		if (isFile(filePath)) result.set(name, filePath);
	}

	return result;
}

function parseModelsArray(arr: unknown, keyPath: string): ModelSpec[] | undefined {
	if (arr === undefined) return undefined;
	if (!Array.isArray(arr)) {
		throw new AgentRegistryConfigError(`${keyPath} must be an array`);
	}
	if (arr.length === 0) {
		throw new AgentRegistryConfigError(`${keyPath} must contain at least one model`);
	}

	const result: ModelSpec[] = [];
	for (let i = 0; i < arr.length; i++) {
		const entry = arr[i];
		const entryPath = `${keyPath}[${i}]`;
		if (!isRecord(entry)) {
			throw new AgentRegistryConfigError(`${entryPath} must be an object`);
		}

		for (const key of Object.keys(entry)) {
			if (key !== "model" && key !== "thinking") {
				throw new AgentRegistryConfigError(
					`${entryPath}.${key} is not supported (allowed keys: model, thinking)`,
				);
			}
		}

		const model = entry["model"];
		if (typeof model !== "string" || model.trim().length === 0) {
			throw new AgentRegistryConfigError(`${entryPath}.model must be a non-empty string`);
		}

		const thinking = entry["thinking"];
		let validatedThinking: ThinkingLevel | "inherit" | undefined;
		if (thinking !== undefined) {
			if (
				typeof thinking !== "string" ||
				!THINKING_LEVELS.has(thinking as ThinkingLevel | "inherit")
			) {
				throw new AgentRegistryConfigError(
					`${entryPath}.thinking must be one of: off, minimal, low, medium, high, xhigh, inherit`,
				);
			}
			validatedThinking = thinking as ThinkingLevel | "inherit";
		}

		const spec: ModelSpec =
			validatedThinking === undefined ? { model } : { model, thinking: validatedThinking };

		result.push(spec);
	}

	return result;
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

function findNearestProjectSettingsPath(cwd: string): string | null {
	const piDir = findNearestProjectPiDir(cwd);
	if (!piDir) return null;
	const candidate = path.join(piDir, "settings.json");
	return isFile(candidate) ? candidate : null;
}

function loadAgentSettings(cwd: string): Map<string, AgentSettingsOverride> {
	const result = new Map<string, AgentSettingsOverride>();

	const applySettings = (settingsPath: string) => {
		const jsonResult = readJsonFileDetailed(settingsPath);
		if (jsonResult._tag === "missing") return;
		if (jsonResult._tag === "invalid") {
			throw new AgentRegistryConfigError(
				`Invalid JSON in ${settingsPath}: ${jsonResult.reason}`,
			);
		}

		const agents = jsonResult.data["agents"];
		if (agents === undefined) return;
		if (!isRecord(agents)) {
			throw new AgentRegistryConfigError(
				`Invalid settings in ${settingsPath}: agents must be an object`,
			);
		}

		for (const [name, config] of Object.entries(agents)) {
			const agentPath = `${settingsPath}#agents.${name}`;
			if (isPromptModeName(name)) {
				throw new AgentRegistryConfigError(
					`Invalid settings in ${agentPath}: mode agents are configured under promptModes, not agents.`,
				);
			}
			if (!isRecord(config)) {
				throw new AgentRegistryConfigError(
					`Invalid settings in ${agentPath}: value must be an object`,
				);
			}

			for (const key of Object.keys(config)) {
				if (!ALLOWED_AGENT_SETTINGS_KEYS.has(key)) {
					throw new AgentRegistryConfigError(
						`Invalid settings in ${agentPath}: ${key} is not supported (allowed keys: models, complexity)`,
					);
				}
			}

			const override: AgentSettingsOverride = {};
			const models = parseModelsArray(config["models"], `${agentPath}.models`);
			if (models) override.models = models;

			const complexity = config["complexity"];
			if (complexity !== undefined) {
				if (!isRecord(complexity)) {
					throw new AgentRegistryConfigError(
						`Invalid settings in ${agentPath}.complexity: value must be an object`,
					);
				}

				override.complexity = {};
				for (const key of Object.keys(complexity)) {
					if (!COMPLEXITY_LEVELS.includes(key as "low" | "medium" | "high")) {
						throw new AgentRegistryConfigError(
							`Invalid settings in ${agentPath}.complexity: ${key} is not supported (allowed keys: low, medium, high)`,
						);
					}
				}

				for (const level of COMPLEXITY_LEVELS) {
					const levelConfig = complexity[level];
					if (levelConfig === undefined) continue;
					if (!isRecord(levelConfig)) {
						throw new AgentRegistryConfigError(
							`Invalid settings in ${agentPath}.complexity.${level}: value must be an object`,
						);
					}

					for (const key of Object.keys(levelConfig)) {
						if (!ALLOWED_COMPLEXITY_CONFIG_KEYS.has(key)) {
							throw new AgentRegistryConfigError(
								`Invalid settings in ${agentPath}.complexity.${level}: ${key} is not supported (allowed keys: models)`,
							);
						}
					}

					const levelModels = parseModelsArray(
						levelConfig["models"],
						`${agentPath}.complexity.${level}.models`,
					);
					if (!levelModels) {
						throw new AgentRegistryConfigError(
							`Invalid settings in ${agentPath}.complexity.${level}: models is required`,
						);
					}
					override.complexity[level] = { models: levelModels };
				}

				if (Object.keys(override.complexity).length === 0) {
					throw new AgentRegistryConfigError(
						`Invalid settings in ${agentPath}: complexity must define at least one of low, medium, high`,
					);
				}
			}

			if (Object.keys(override).length > 0) {
				const existing = result.get(name);
				result.set(name, existing ? { ...existing, ...override } : override);
			}
		}
	};

	const globalSettings = getUserSettingsPath();
	applySettings(globalSettings);

	const projectSettings = findNearestProjectSettingsPath(cwd);
	if (projectSettings) applySettings(projectSettings);

	return result;
}

function parseAndValidateAgentFile(expectedName: string, filePath: string): AgentDefinition {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		throw new AgentRegistryConfigError(
			`Failed to read agent definition ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	let definition: AgentDefinition;
	try {
		definition = parseAgentDefinition(content);
	} catch (error) {
		throw new AgentRegistryConfigError(
			`Invalid agent definition ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (definition.name !== expectedName) {
		throw new AgentRegistryConfigError(
			`Invalid agent definition ${filePath}: frontmatter name "${definition.name}" must match filename "${expectedName}.md"`,
		);
	}

	return definition;
}

function formatValidationErrors(errors: readonly string[]): string {
	if (errors.length === 1) {
		return errors[0] ?? "Invalid agent definition";
	}

	const sorted = [...errors].sort((a, b) => a.localeCompare(b));
	const details = sorted.map((error) => `- ${error}`).join("\n");
	return `Invalid agent definition files:\n${details}`;
}

interface AgentSummary {
	readonly name: string;
	readonly description: string;
}

export class AgentRegistry {
	private readonly definitions: Map<string, AgentDefinition>;
	private readonly settingsOverrides: Map<string, AgentSettingsOverride>;
	private readonly modeAgents: Map<PromptModeName, AgentDefinition>;
	private readonly cwd: string;

	private constructor(args: {
		definitions: Map<string, AgentDefinition>;
		settingsOverrides: Map<string, AgentSettingsOverride>;
		modeAgents: Map<PromptModeName, AgentDefinition>;
		cwd: string;
	}) {
		this.definitions = args.definitions;
		this.settingsOverrides = args.settingsOverrides;
		this.modeAgents = args.modeAgents;
		this.cwd = args.cwd;
	}

	static load(cwd: string): AgentRegistry {
		const extensionAgents = discoverAgentFiles(EXTENSION_AGENTS_DIR);
		const userAgentsDir = getUserAgentsDir();
		const userAgents = discoverAgentFiles(userAgentsDir);

		const projectPi = findNearestProjectPiDir(cwd);
		const projectAgents =
			projectPi === null
				? new Map<string, string>()
				: discoverAgentFiles(path.join(projectPi, "agents"));

		const parsedByPath = new Map<string, AgentDefinition>();
		const validationErrors: string[] = [];
		const validateSource = (files: Map<string, string>) => {
			for (const [name, filePath] of files) {
				try {
					parsedByPath.set(filePath, parseAndValidateAgentFile(name, filePath));
				} catch (error) {
					validationErrors.push(error instanceof Error ? error.message : String(error));
				}
			}
		};

		// Validate every discovered file (including overridden ones) so misconfiguration
		// never gets silently ignored.
		validateSource(extensionAgents);
		validateSource(userAgents);
		validateSource(projectAgents);

		if (validationErrors.length > 0) {
			throw new AgentRegistryConfigError(formatValidationErrors(validationErrors));
		}

		const mergedPaths = new Map<string, string>();
		for (const [name, filePath] of extensionAgents) {
			mergedPaths.set(name, filePath);
		}
		for (const [name, filePath] of userAgents) {
			mergedPaths.set(name, filePath);
		}
		for (const [name, filePath] of projectAgents) {
			mergedPaths.set(name, filePath);
		}

		const definitions = new Map<string, AgentDefinition>();
		for (const [name, filePath] of mergedPaths) {
			const definition = parsedByPath.get(filePath);
			if (!definition) {
				throw new AgentRegistryConfigError(
					`Internal error: missing parsed agent definition for ${filePath}`,
				);
			}
			definitions.set(name, definition);
		}

		const modeAgents = new Map<PromptModeName, AgentDefinition>();
		for (const mode of ["smart", "deep", "rush"] as const) {
			modeAgents.set(mode, buildModeAgentDefinition(mode, cwd));
		}

		return new AgentRegistry({
			definitions,
			settingsOverrides: loadAgentSettings(cwd),
			modeAgents,
			cwd,
		});
	}

	get(name: string): AgentDefinition | undefined {
		if (isPromptModeName(name)) {
			return this.modeAgents.get(name);
		}

		return this.definitions.get(name);
	}

	has(name: string): boolean {
		return isPromptModeName(name) ? this.modeAgents.has(name) : this.definitions.has(name);
	}

	names(): string[] {
		const names = new Set<string>([...this.definitions.keys(), ...this.modeAgents.keys()]);
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
