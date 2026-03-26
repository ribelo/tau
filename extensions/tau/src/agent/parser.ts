import { Data, Effect, Schema } from "effect";
import { parse } from "yaml";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentDefinition, ModelSpec } from "./types.js";
import type { SandboxConfig } from "../sandbox/config.js";
import { ApprovalTimeoutSeconds } from "../schemas/config.js";
import { APPROVAL_POLICIES, FILESYSTEM_MODES, NETWORK_MODES, SANDBOX_PRESET_NAMES, inferPresetFromModes } from "../shared/policy.js";
import { EXTENSION_AGENTS_DIR, getUserAgentsDir } from "../shared/discovery.js";
import { findNearestProjectPiDirEffect } from "../shared/settings.js";
import { decodeAgentModelSpec } from "./model-spec.js";
import { parseConfiguredToolNames } from "./tool-allowlist.js";

export class AgentDefinitionError extends Data.TaggedError("AgentDefinitionError")<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

const SandboxPresetSchema = Schema.Literals([...SANDBOX_PRESET_NAMES]);

const FilesystemModeSchema = Schema.Literals([...FILESYSTEM_MODES]);

const NetworkModeSchema = Schema.Literals([...NETWORK_MODES]);

const ApprovalPolicySchema = Schema.Literals([...APPROVAL_POLICIES]);

const AgentDefinitionFrontmatterSchema = Schema.Struct({
	name: Schema.String,
	description: Schema.String,
	models: Schema.NonEmptyArray(Schema.Unknown),
	tools: Schema.optional(Schema.Array(Schema.Unknown)),
	sandbox_preset: Schema.optional(SandboxPresetSchema),
	// Legacy fields still accepted for back-compat
	sandbox_fs: Schema.optional(FilesystemModeSchema),
	sandbox_net: Schema.optional(NetworkModeSchema),
	approval_policy: Schema.optional(ApprovalPolicySchema),
	approval_timeout: Schema.optional(ApprovalTimeoutSeconds),
});

export function parseAgentDefinition(
	content: string,
): Effect.Effect<AgentDefinition, AgentDefinitionError> {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
	if (!match) {
		return Effect.fail(
			new AgentDefinitionError({
				message: "Invalid agent definition: Missing YAML frontmatter",
			}),
		);
	}

	const frontmatterRaw = match[1];
	const systemPromptRaw = match[2];
	if (frontmatterRaw === undefined || systemPromptRaw === undefined) {
		return Effect.fail(
			new AgentDefinitionError({
				message: "Invalid agent definition: Missing YAML frontmatter or body",
			}),
		);
	}

	return Effect.try({
		try: () => parse(frontmatterRaw) as unknown,
		catch: (cause) =>
			new AgentDefinitionError({
				message: "Invalid agent frontmatter: invalid YAML",
				cause,
			}),
	}).pipe(
		Effect.flatMap((frontmatter) =>
			Schema.decodeUnknownEffect(AgentDefinitionFrontmatterSchema)(frontmatter).pipe(
				Effect.mapError(
					(cause) =>
						new AgentDefinitionError({
							message: `Invalid agent frontmatter: ${String(cause)}`,
							cause,
						}),
				),
			),
		),
		Effect.flatMap((parsedFrontmatter) =>
			Effect.forEach(parsedFrontmatter.models, (entry) =>
				decodeAgentModelSpec(entry, "Invalid agent model spec").pipe(
					Effect.mapError(
						(error) =>
							new AgentDefinitionError({
								message: error.message,
								cause: error,
							}),
					),
				),
			).pipe(
				Effect.flatMap((models) =>
					Effect.try({
						try: () => parseConfiguredToolNames(parsedFrontmatter.tools, "tools"),
						catch: (cause) =>
							new AgentDefinitionError({
								message:
									cause instanceof Error
										? cause.message
										: `Invalid agent tools: ${String(cause)}`,
								cause,
							}),
					}).pipe(
						Effect.map((tools): AgentDefinition => {
							const sandbox: SandboxConfig = {
								preset: parsedFrontmatter.sandbox_preset ?? inferPresetFromModes({
									filesystemMode: parsedFrontmatter.sandbox_fs,
									networkMode: parsedFrontmatter.sandbox_net,
									approvalPolicy: parsedFrontmatter.approval_policy,
								}),
							};

							return {
								name: parsedFrontmatter.name,
								description: parsedFrontmatter.description,
								models: models as ReadonlyArray<ModelSpec>,
								...(tools !== undefined ? { tools } : {}),
								sandbox,
								systemPrompt: systemPromptRaw.trim(),
							};
						}),
					),
				),
			),
		),
	);
}

function isFile(filePath: string): Effect.Effect<boolean, AgentDefinitionError> {
	return Effect.tryPromise({
		try: () => fs.stat(filePath),
		catch: (cause) => cause,
	}).pipe(
		Effect.map((stats) => stats.isFile()),
		Effect.catchIf(
			(cause) =>
				typeof cause === "object" &&
				cause !== null &&
				"code" in cause &&
				cause.code === "ENOENT",
			() => Effect.succeed(false),
		),
		Effect.mapError(
			(cause) =>
				new AgentDefinitionError({
					message: `Failed to inspect agent definition ${filePath}`,
					cause,
				}),
		),
	);
}

export function loadAgentDefinition(
	name: string,
	cwd: string,
): Effect.Effect<AgentDefinition | null, AgentDefinitionError> {
	return findNearestProjectPiDirEffect(cwd).pipe(
		Effect.flatMap((projectPi) => {
			const candidates: string[] = [];
			if (projectPi) {
				candidates.push(path.join(projectPi, "agents", `${name}.md`));
			}
			candidates.push(path.join(getUserAgentsDir(), `${name}.md`));
			candidates.push(path.join(EXTENSION_AGENTS_DIR, `${name}.md`));

			return Effect.gen(function* () {
				for (const filePath of candidates) {
					const exists = yield* isFile(filePath);
					if (!exists) {
						continue;
					}

					const contents = yield* Effect.tryPromise({
						try: () => fs.readFile(filePath, "utf-8"),
						catch: (cause) =>
							new AgentDefinitionError({
								message: `Failed to read agent definition ${filePath}`,
								cause,
							}),
					});

					return yield* parseAgentDefinition(contents);
				}

				return null;
			});
		}),
		Effect.mapError((cause) =>
			cause instanceof AgentDefinitionError
				? cause
				: new AgentDefinitionError({
						message: "Failed to load agent definition",
						cause,
					}),
		),
	);
}
