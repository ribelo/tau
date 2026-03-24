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
import { Data, Effect } from "effect";

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
	resolvePromptModePresets,
	type PromptModeName,
	isPromptModeName,
} from "../prompt/modes.js";
import type { SandboxConfig } from "../sandbox/config.js";
import { parseAgentDefinition } from "./parser.js";
import type { AgentDefinition, Complexity, ModelSpec } from "./types.js";
import { decodeAgentModelSpec } from "./model-spec.js";

const MODE_AGENT_SANDBOX: SandboxConfig = {
	preset: "full-access",
};

const COMPLEXITY_LEVELS = ["low", "medium", "high"] as const;
const ALLOWED_AGENT_SETTINGS_KEYS = new Set(["models", "complexity"]);
const ALLOWED_COMPLEXITY_CONFIG_KEYS = new Set(["models"]);

export class AgentRegistryConfigError extends Data.TaggedError("AgentRegistryConfigError")<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (
		typeof error === "object" &&
		error !== null &&
		"message" in error &&
		typeof error.message === "string"
	) {
		return error.message;
	}
	return String(error);
}

function buildModeAgentDefinition(
	mode: PromptModeName,
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
								message: `Invalid agent file ${path.join(dir, entry.name)}: mode agents (smart, deep, rush) are virtual and cannot be defined as .md files.`,
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
			if (isPromptModeName(name)) {
				return yield* Effect.fail(
					new AgentRegistryConfigError({
						message: `Invalid settings in ${agentPath}: mode agents are configured under promptModes, not agents.`,
					}),
				);
			}
			if (!isRecord(config)) {
				return yield* Effect.fail(
					new AgentRegistryConfigError({
						message: `Invalid settings in ${agentPath}: value must be an object`,
					}),
				);
			}

			for (const key of Object.keys(config)) {
				if (!ALLOWED_AGENT_SETTINGS_KEYS.has(key)) {
					return yield* Effect.fail(
						new AgentRegistryConfigError({
							message: `Invalid settings in ${agentPath}: ${key} is not supported (allowed keys: models, complexity)`,
						}),
					);
				}
			}

			const models = yield* parseModelsArray(config["models"], `${agentPath}.models`);
			const override: AgentSettingsOverride = {};
			if (models) override.models = models;

			const complexity = config["complexity"];
			if (complexity !== undefined) {
				if (!isRecord(complexity)) {
					return yield* Effect.fail(
						new AgentRegistryConfigError({
							message: `Invalid settings in ${agentPath}.complexity: value must be an object`,
						}),
					);
				}

				for (const key of Object.keys(complexity)) {
					if (!COMPLEXITY_LEVELS.includes(key as "low" | "medium" | "high")) {
						return yield* Effect.fail(
							new AgentRegistryConfigError({
								message: `Invalid settings in ${agentPath}.complexity: ${key} is not supported (allowed keys: low, medium, high)`,
							}),
						);
					}
				}

				const complexityOverride: NonNullable<AgentSettingsOverride["complexity"]> = {};
				for (const level of COMPLEXITY_LEVELS) {
					const levelConfig = complexity[level];
					if (levelConfig === undefined) {
						continue;
					}
					if (!isRecord(levelConfig)) {
						return yield* Effect.fail(
							new AgentRegistryConfigError({
								message: `Invalid settings in ${agentPath}.complexity.${level}: value must be an object`,
							}),
						);
					}

					for (const key of Object.keys(levelConfig)) {
						if (!ALLOWED_COMPLEXITY_CONFIG_KEYS.has(key)) {
							return yield* Effect.fail(
								new AgentRegistryConfigError({
									message: `Invalid settings in ${agentPath}.complexity.${level}: ${key} is not supported (allowed keys: models)`,
								}),
							);
						}
					}

					const levelModels = yield* parseModelsArray(
						levelConfig["models"],
						`${agentPath}.complexity.${level}.models`,
					);
					if (levelModels === undefined) {
						return yield* Effect.fail(
							new AgentRegistryConfigError({
								message: `Invalid settings in ${agentPath}.complexity.${level}: models is required`,
							}),
						);
					}
					complexityOverride[level] = { models: levelModels };
				}

				if (Object.keys(complexityOverride).length === 0) {
					return yield* Effect.fail(
						new AgentRegistryConfigError({
							message: `Invalid settings in ${agentPath}: complexity must define at least one of low, medium, high`,
						}),
					);
				}

				override.complexity = complexityOverride;
			}

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

			const parsedByPath = new Map<string, AgentDefinition>();
			const validationErrors: string[] = [];
			const validateSource = (files: Map<string, string>) =>
				Effect.forEach(Array.from(files.entries()), ([name, filePath]) =>
					parseAndValidateAgentFile(name, filePath).pipe(
						Effect.tap((definition) =>
							Effect.sync(() => {
								parsedByPath.set(filePath, definition);
							}),
						),
						Effect.catch((error: AgentRegistryConfigError) =>
							Effect.sync(() => {
								validationErrors.push(error.message);
							}),
						),
					),
				).pipe(Effect.asVoid);

			yield* validateSource(extensionAgents);
			yield* validateSource(userAgents);
			yield* validateSource(projectAgents);

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
			const modeAgents = new Map<PromptModeName, AgentDefinition>(modeAgentEntries);

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
			return this.modeAgents.get(name);
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
