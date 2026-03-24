import { Schema } from "effect";
import { parse } from "yaml";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentDefinition, ModelSpec } from "./types.js";
import type { SandboxConfig } from "../sandbox/config.js";
import { ApprovalTimeoutSeconds } from "../schemas/config.js";
import { APPROVAL_POLICIES, FILESYSTEM_MODES, NETWORK_MODES, SANDBOX_PRESET_NAMES, inferPresetFromModes } from "../shared/policy.js";
import { EXTENSION_AGENTS_DIR, findNearestProjectPiDir, getUserAgentsDir } from "../shared/discovery.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "inherit"] as const;

const ThinkingLevelSchema = Schema.Literals([...THINKING_LEVELS]);

const SandboxPresetSchema = Schema.Literals([...SANDBOX_PRESET_NAMES]);

const FilesystemModeSchema = Schema.Literals([...FILESYSTEM_MODES]);

const NetworkModeSchema = Schema.Literals([...NETWORK_MODES]);

const ApprovalPolicySchema = Schema.Literals([...APPROVAL_POLICIES]);

const ModelSpecSchema = Schema.Struct({
	model: Schema.String,
	thinking: Schema.optional(ThinkingLevelSchema),
});

const AgentDefinitionFrontmatterSchema = Schema.Struct({
	name: Schema.String,
	description: Schema.String,
	models: Schema.NonEmptyArray(ModelSpecSchema),
	sandbox_preset: Schema.optional(SandboxPresetSchema),
	// Legacy fields still accepted for back-compat
	sandbox_fs: Schema.optional(FilesystemModeSchema),
	sandbox_net: Schema.optional(NetworkModeSchema),
	approval_policy: Schema.optional(ApprovalPolicySchema),
	approval_timeout: Schema.optional(ApprovalTimeoutSeconds),
});

const decodeModelSpec = Schema.decodeUnknownSync(ModelSpecSchema);
const decodeAgentDefinitionFrontmatter = Schema.decodeUnknownSync(AgentDefinitionFrontmatterSchema);

function parseModelSpec(entry: unknown): ModelSpec {
	const modelSpec = decodeModelSpec(entry);
	return {
		model: modelSpec.model,
		...(modelSpec.thinking === undefined ? {} : { thinking: modelSpec.thinking }),
	};
}

export function parseAgentDefinition(content: string): AgentDefinition {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
	if (!match) {
		throw new Error("Invalid agent definition: Missing YAML frontmatter");
	}

	const frontmatterRaw = match[1];
	const systemPromptRaw = match[2];
	if (frontmatterRaw === undefined || systemPromptRaw === undefined) {
		throw new Error("Invalid agent definition: Missing YAML frontmatter or body");
	}

	const frontmatter = parse(frontmatterRaw);
	const systemPrompt = systemPromptRaw.trim();
	const parsedFrontmatter = decodeAgentDefinitionFrontmatter(frontmatter);

	const models: ModelSpec[] = parsedFrontmatter.models.map((entry) => parseModelSpec(entry));

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
		models,
		sandbox,
		systemPrompt,
	};
}

function isFile(p: string): boolean {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

export function loadAgentDefinition(name: string, cwd: string): AgentDefinition | null {
	const projectPi = findNearestProjectPiDir(cwd);
	const candidates: string[] = [];

	if (projectPi) {
		candidates.push(path.join(projectPi, "agents", `${name}.md`));
	}

	candidates.push(path.join(getUserAgentsDir(), `${name}.md`));
	candidates.push(path.join(EXTENSION_AGENTS_DIR, `${name}.md`));

	for (const filePath of candidates) {
		if (!isFile(filePath)) continue;
		try {
			const contents = fs.readFileSync(filePath, "utf-8");
			return parseAgentDefinition(contents);
		} catch (e) {
			console.error(`Error loading agent definition from ${filePath}:`, e);
			continue;
		}
	}

	return null;
}
