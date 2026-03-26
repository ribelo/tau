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

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { Data, Effect, Result } from "effect";

import { errorMessage } from "../shared/error-message.js";
import { isRecord } from "../shared/json.js";
import {
	EXTENSION_AGENTS_DIR,
	getUserAgentsDir,
} from "../shared/discovery.js";
import {
	findNearestProjectPiDirEffect,
	readProjectSettings,
	readUserSettings,
	SettingsError,
} from "../shared/settings.js";
import {
	isPromptModeName,
	isPromptModePresetName,
	resolvePromptModePresets,
	type PromptModePresetName,
} from "../prompt/modes.js";
import type { SandboxConfig } from "../sandbox/config.js";
import { parseAgentDefinition } from "./parser.js";
import { parseConfiguredToolNames } from "./tool-allowlist.js";
import type { AgentDefinition, ModelSpec } from "./types.js";
import { decodeAgentModelSpec, isPromptModeThinkingLevel, validatePromptModeModelId } from "./model-spec.js";

const MODE_AGENT_SANDBOX: SandboxConfig = {
	preset: "full-access",
};

const MODE_AGENT_TOOLS = [
	"read",
	"bash",
	"edit",
	"write",
	"agent",
	"bd",
	"web_search_exa",
	"crawling_exa",
	"get_code_context_exa",
] as const;

const ALLOWED_AGENT_SETTINGS_KEYS = new Set(["models", "model", "thinking", "tools", "spawns"]);

export class AgentRegistryConfigError extends Data.TaggedError("AgentRegistryConfigError")<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

function buildModeAgentDefinition(
	mode: PromptModePresetName,
	cwd: string,
): Effect.Effect<AgentDefinition, AgentRegistryConfigError | SettingsError> {
	return resolvePromptModePresets(cwd).pipe(
		Effect.map((presets) => {
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
				tools: MODE_AGENT_TOOLS,
				sandbox: MODE_AGENT_SANDBOX,
				systemPrompt: preset.systemPrompt,
			};
		}),
		Effect.mapError((cause) =>
			cause instanceof AgentRegistryConfigError
				? cause
				: new AgentRegistryConfigError({
						message: `Failed to build mode agent "${mode}"`,
						cause,
					}),
		),
	);
}

function discoverAgentFiles(
	dir: string,
): Effect.Effect<Map<string, string>, AgentRegistryConfigError> {
	return Effect.tryPromise({
		try: () => fs.readdir(dir, { withFileTypes: true }),
		catch: (cause) => cause,
	}).pipe(
		Effect.catchIf(
			(cause) =>
				typeof cause === "object" &&
				cause !== null &&
				"code" in cause &&
				cause.code === "ENOENT",
			() => Effect.succeed([]),
		),
		Effect.mapError(
			(cause) =>
				new AgentRegistryConfigError({
					message: `Failed to read agent directory ${dir}`,
						cause,
					}),
		),
		Effect.flatMap((entries) =>
			Effect.gen(function* () {
				const result = new Map<string, string>();
				for (const entry of entries) {
					if (!entry.isFile() || !entry.name.endsWith(".md")) {
						continue;
					}
					const name = entry.name.slice(0, -3);
					if (isPromptModeName(name)) {
						return yield* Effect.fail(
							new AgentRegistryConfigError({
								message: `Invalid agent file ${path.join(dir, entry.name)}: prompt mode names (default, smart, deep, rush) are reserved; smart, deep, and rush are virtual agents, and default is not spawnable.`,
							}),
						);
					}
					result.set(name, path.join(dir, entry.name));
				}
				return result;
			}),
		),
		Effect.mapError((cause) =>
			cause instanceof AgentRegistryConfigError
				? cause
				: new AgentRegistryConfigError({
						message: `Failed to discover agent files in ${dir}`,
						cause,
					}),
		),
	);
}

function parseModelsArray(
	arr: unknown,
	keyPath: string,
): Effect.Effect<readonly ModelSpec[] | undefined, AgentRegistryConfigError> {
	if (arr === undefined) return Effect.succeed(undefined);
	if (!Array.isArray(arr)) {
		return Effect.fail(new AgentRegistryConfigError({ message: `${keyPath} must be an array` }));
	}
	if (arr.length === 0) {
		return Effect.fail(
			new AgentRegistryConfigError({ message: `${keyPath} must contain at least one model` }),
		);
	}

	return Effect.forEach(arr, (entry, index) => {
		const entryPath = `${keyPath}[${index}]`;
		if (!isRecord(entry)) {
			return Effect.fail(
				new AgentRegistryConfigError({ message: `${entryPath} must be an object` }),
			);
		}

		for (const key of Object.keys(entry)) {
			if (key !== "model" && key !== "thinking") {
				return Effect.fail(
					new AgentRegistryConfigError({
						message: `${entryPath}.${key} is not supported (allowed keys: model, thinking)`,
					}),
				);
			}
		}

		return decodeAgentModelSpec(entry, entryPath).pipe(
			Effect.mapError(
				(error) =>
					new AgentRegistryConfigError({
						message: error.message,
						cause: error,
					}),
			),
		);
	});
}

function parseToolsArray(
	value: unknown,
	keyPath: string,
): Effect.Effect<readonly string[] | undefined, AgentRegistryConfigError> {
	return Effect.try({
		try: () => parseConfiguredToolNames(value, keyPath),
		catch: (cause) =>
			new AgentRegistryConfigError({
				message: cause instanceof Error ? cause.message : `Invalid tools in ${keyPath}`,
				cause,
			}),
	});
}

function parseSpawnsRestriction(
	value: unknown,
	keyPath: string,
): Effect.Effect<readonly string[] | "*" | undefined, AgentRegistryConfigError> {
	if (value === undefined) {
		return Effect.succeed(undefined);
	}
	if (value === "*") {
		return Effect.succeed("*");
	}
	if (!Array.isArray(value)) {
		return Effect.fail(
			new AgentRegistryConfigError({
				message: `${keyPath} must be "*" or an array of strings`,
			}),
		);
	}

	const spawns: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") {
			return Effect.fail(
				new AgentRegistryConfigError({
					message: `${keyPath} must be "*" or an array of strings`,
				}),
			);
		}
		spawns.push(entry);
	}
	return Effect.succeed(spawns);
}

function parseModelShorthand(
	value: unknown,
	thinkingValue: unknown,
	keyPath: string,
): Effect.Effect<readonly ModelSpec[] | undefined, AgentRegistryConfigError> {
	if (value === undefined) return Effect.succeed(undefined);
	if (typeof value !== "string") {
		return Effect.fail(new AgentRegistryConfigError({ message: `${keyPath}: must be a string` }));
	}

	const thinkingKeyPath = keyPath.replace(".model", ".thinking");
	if (value === "inherit") {
		if (thinkingValue === undefined || thinkingValue === "inherit") {
			return Effect.succeed([{ model: "inherit", thinking: "inherit" }] as const);
		}
		if (typeof thinkingValue !== "string") {
			return Effect.fail(
				new AgentRegistryConfigError({ message: `${thinkingKeyPath}: must be a string` }),
			);
		}
		if (!isPromptModeThinkingLevel(thinkingValue)) {
			return Effect.fail(
				new AgentRegistryConfigError({
					message: `${thinkingKeyPath}: must be one of inherit, off, minimal, low, medium, high, xhigh`,
				}),
			);
		}
		return Effect.succeed([{ model: "inherit", thinking: thinkingValue }] as const);
	}

	return validatePromptModeModelId(value, keyPath).pipe(
		Effect.mapError(
			(error) =>
				new AgentRegistryConfigError({
					message: error.message,
					cause: error,
				}),
		),
		Effect.flatMap((model) => {
			if (thinkingValue === undefined) {
				return Effect.succeed([{ model }] as const);
			}
			if (typeof thinkingValue !== "string") {
				return Effect.fail(
					new AgentRegistryConfigError({ message: `${thinkingKeyPath}: must be a string` }),
				);
			}
			if (!isPromptModeThinkingLevel(thinkingValue)) {
				return Effect.fail(
					new AgentRegistryConfigError({
						message: `${thinkingKeyPath}: must be one of off, minimal, low, medium, high, xhigh`,
					}),
				);
			}
			return Effect.succeed([{ model, thinking: thinkingValue }] as const);
		}),
	);
}

interface AgentSettingsOverride {
	models?: readonly ModelSpec[];
	tools?: readonly string[];
	spawns?: readonly string[] | "*";
}

function mergeSettingsOverride(
	result: Map<string, AgentSettingsOverride>,
	name: string,
	override: AgentSettingsOverride,
): Map<string, AgentSettingsOverride> {
	const next = new Map(result);
	const existing = next.get(name);
	next.set(name, existing ? { ...existing, ...override } : override);
	return next;
}

function loadAgentSettingsFromJson(
	settings: unknown,
	context: string,
	initial: Map<string, AgentSettingsOverride>,
): Effect.Effect<Map<string, AgentSettingsOverride>, AgentRegistryConfigError> {
	if (!isRecord(settings)) {
		return Effect.fail(
			new AgentRegistryConfigError({
				message: `Invalid settings in ${context}: top-level value must be an object`,
			}),
		);
	}

	const agents = settings["agents"];
	if (agents === undefined) return Effect.succeed(initial);
	if (!isRecord(agents)) {
		return Effect.fail(
			new AgentRegistryConfigError({
				message: `Invalid settings in ${context}: agents must be an object`,
			}),
		);
	}

	return Effect.gen(function* () {
		let result = initial;
		for (const [name, config] of Object.entries(agents)) {
			const agentPath = `${context}#agents.${name}`;
			if (!isRecord(config)) {
				return yield* Effect.fail(
					new AgentRegistryConfigError({
						message: `Invalid settings in ${agentPath}: value must be an object`,
					}),
				);
			}
			if (isPromptModePresetName(name)) {
				for (const key of Object.keys(config)) {
					if (key !== "tools" && key !== "spawns") {
						return yield* Effect.fail(
							new AgentRegistryConfigError({
								message: `Invalid settings in ${agentPath}: mode agents only support tools and spawns here; prompt mode model settings belong under promptModes`,
							}),
						);
					}
				}

				const tools = yield* parseToolsArray(config["tools"], `${agentPath}.tools`);
				const spawns = yield* parseSpawnsRestriction(
					config["spawns"],
					`${agentPath}.spawns`,
				);
				if (tools !== undefined || spawns !== undefined) {
					result = mergeSettingsOverride(result, name, {
						...(tools !== undefined ? { tools } : {}),
						...(spawns !== undefined ? { spawns } : {}),
					});
				}
				continue;
			}
			if (name === "default") {
				return yield* Effect.fail(
					new AgentRegistryConfigError({
						message: `Invalid settings in ${agentPath}: default mode is not a spawnable agent and does not accept agent settings`,
					}),
				);
			}

			for (const key of Object.keys(config)) {
				if (!ALLOWED_AGENT_SETTINGS_KEYS.has(key)) {
					return yield* Effect.fail(
						new AgentRegistryConfigError({
							message: `Invalid settings in ${agentPath}: ${key} is not supported (allowed keys: model, thinking, models, tools, spawns)`,
						}),
					);
				}
			}

			if (config["model"] !== undefined && config["models"] !== undefined) {
				return yield* Effect.fail(
					new AgentRegistryConfigError({
						message: `${agentPath}: cannot specify both 'model' and 'models'`,
					}),
				);
			}

			if (config["thinking"] !== undefined && config["model"] === undefined) {
				return yield* Effect.fail(
					new AgentRegistryConfigError({
						message: `${agentPath}: 'thinking' requires 'model' (use 'models' array for full control)`,
					}),
				);
			}

			const models =
				config["model"] !== undefined
					? yield* parseModelShorthand(config["model"], config["thinking"], `${agentPath}.model`)
					: yield* parseModelsArray(config["models"], `${agentPath}.models`);
			const tools = yield* parseToolsArray(config["tools"], `${agentPath}.tools`);
			const spawns = yield* parseSpawnsRestriction(config["spawns"], `${agentPath}.spawns`);
			const override: AgentSettingsOverride = {};
			if (models) override.models = models;
			if (tools !== undefined) override.tools = tools;
			if (spawns !== undefined) override.spawns = spawns;

			if (Object.keys(override).length > 0) {
				result = mergeSettingsOverride(result, name, override);
			}
		}
		return result;
	});
}

function loadAgentSettings(
	cwd: string,
): Effect.Effect<Map<string, AgentSettingsOverride>, AgentRegistryConfigError | SettingsError> {
	return Effect.all({
		userSettings: readUserSettings(),
		projectSettings: readProjectSettings(cwd),
	}).pipe(
		Effect.flatMap(({ userSettings, projectSettings }) =>
			loadAgentSettingsFromJson(userSettings ?? {}, "user settings", new Map()).pipe(
				Effect.flatMap((result) =>
					loadAgentSettingsFromJson(projectSettings ?? {}, "project settings", result),
				),
			),
		),
	);
}

function parseAndValidateAgentFile(
	expectedName: string,
	filePath: string,
): Effect.Effect<AgentDefinition, AgentRegistryConfigError> {
	return Effect.tryPromise({
		try: () => fs.readFile(filePath, "utf-8"),
		catch: (cause) =>
			new AgentRegistryConfigError({
				message: `Failed to read agent definition ${filePath}`,
				cause,
			}),
	}).pipe(
		Effect.flatMap((content) => parseAgentDefinition(content)),
		Effect.mapError((cause) =>
			cause instanceof AgentRegistryConfigError
				? cause
				: new AgentRegistryConfigError({
						message: `Invalid agent definition ${filePath}: ${errorMessage(cause)}`,
						cause,
					}),
		),
		Effect.flatMap((definition) =>
			definition.name !== expectedName
				? Effect.fail(
						new AgentRegistryConfigError({
							message: `Invalid agent definition ${filePath}: frontmatter name "${definition.name}" must match filename "${expectedName}.md"`,
						}),
					)
				: Effect.succeed(definition),
		),
	);
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
	private readonly modeAgents: Map<PromptModePresetName, AgentDefinition>;
	private readonly cwd: string;

	private constructor(args: {
		definitions: Map<string, AgentDefinition>;
		settingsOverrides: Map<string, AgentSettingsOverride>;
		modeAgents: Map<PromptModePresetName, AgentDefinition>;
		cwd: string;
	}) {
		this.definitions = args.definitions;
		this.settingsOverrides = args.settingsOverrides;
		this.modeAgents = args.modeAgents;
		this.cwd = args.cwd;
	}

	static load(
		cwd: string,
	): Effect.Effect<AgentRegistry, AgentRegistryConfigError | SettingsError> {
		return Effect.gen(function* () {
			const extensionAgents = yield* discoverAgentFiles(EXTENSION_AGENTS_DIR);
			const userAgents = yield* discoverAgentFiles(getUserAgentsDir());
			const projectPi = yield* findNearestProjectPiDirEffect(cwd);
			const projectAgents =
				projectPi === null
					? new Map<string, string>()
					: yield* discoverAgentFiles(path.join(projectPi, "agents"));

			const validateSource = (files: Map<string, string>) =>
				Effect.forEach(Array.from(files.entries()), ([name, filePath]) =>
					parseAndValidateAgentFile(name, filePath).pipe(
						Effect.map((definition) => [filePath, definition] as const),
						Effect.result,
					),
				);

			const allResults = [
				...(yield* validateSource(extensionAgents)),
				...(yield* validateSource(userAgents)),
				...(yield* validateSource(projectAgents)),
			];

			const validationErrors: string[] = [];
			const parsedByPath = new Map<string, AgentDefinition>();
			for (const result of allResults) {
				if (Result.isFailure(result)) {
					validationErrors.push(result.failure.message);
				} else {
					const [filePath, definition] = result.success;
					parsedByPath.set(filePath, definition);
				}
			}

			if (validationErrors.length > 0) {
				return yield* Effect.fail(
					new AgentRegistryConfigError({
						message: formatValidationErrors(validationErrors),
					}),
				);
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
					return yield* Effect.fail(
						new AgentRegistryConfigError({
							message: `Internal error: missing parsed agent definition for ${filePath}`,
						}),
					);
				}
				definitions.set(name, definition);
			}

			const modeAgentEntries = yield* Effect.all(
				(["smart", "deep", "rush"] as const).map((mode) =>
					buildModeAgentDefinition(mode, cwd).pipe(Effect.map((definition) => [mode, definition] as const)),
				),
			);
			const modeAgents = new Map<PromptModePresetName, AgentDefinition>(modeAgentEntries);

			return new AgentRegistry({
				definitions,
				settingsOverrides: yield* loadAgentSettings(cwd),
				modeAgents,
				cwd,
			});
		}).pipe(
			Effect.mapError((cause) =>
				cause instanceof AgentRegistryConfigError || cause instanceof SettingsError
					? cause
					: new AgentRegistryConfigError({
							message: "Failed to load agent registry",
							cause,
						}),
			),
		) as Effect.Effect<AgentRegistry, AgentRegistryConfigError | SettingsError>;
	}

	get(name: string): AgentDefinition | undefined {
		if (isPromptModePresetName(name)) {
			return this.modeAgents.get(name);
		}

		if (name === "default") {
			return undefined;
		}

		return this.definitions.get(name);
	}

	has(name: string): boolean {
		if (isPromptModePresetName(name)) {
			return this.modeAgents.has(name);
		}

		return name === "default" ? false : this.definitions.has(name);
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

	resolve(name: string): AgentDefinition | undefined {
		if (isPromptModePresetName(name)) {
			const def = this.modeAgents.get(name);
			if (!def) return undefined;
			const override = this.settingsOverrides.get(name);
			if (!override) return def;
			return {
				...def,
				...(override.tools !== undefined ? { tools: override.tools } : {}),
				...(override.spawns !== undefined ? { spawns: override.spawns } : {}),
			};
		}

		if (name === "default") {
			return undefined;
		}

		const def = this.get(name);
		if (!def) return undefined;

		const override = this.settingsOverrides.get(name);
		if (!override) return def;

		let models = def.models;
		if (override.models) models = override.models;

		return {
			...def,
			models,
			...(override.tools !== undefined ? { tools: override.tools } : {}),
			...(override.spawns !== undefined ? { spawns: override.spawns } : {}),
		};
	}
}
