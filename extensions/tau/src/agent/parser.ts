import { Schema } from "effect";
import { parse } from "yaml";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import type { AgentDefinition, ModelSpec } from "./types.js";
import type { SandboxConfig } from "../sandbox/config.js";
import { ApprovalTimeoutSeconds } from "../schemas/config.js";
import {
	APPROVAL_POLICIES,
	FILESYSTEM_MODES,
	NETWORK_MODES,
} from "../shared/policy.js";

const EXTENSION_AGENTS_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"agents",
);

const THINKING_LEVELS = ["low", "medium", "high", "inherit"] as const;

const ThinkingLevelSchema = Schema.Literal(...THINKING_LEVELS);

const FilesystemModeSchema = Schema.Literal(...FILESYSTEM_MODES);

const NetworkModeSchema = Schema.Literal(...NETWORK_MODES);

const ApprovalPolicySchema = Schema.Literal(...APPROVAL_POLICIES);

const ModelSpecSchema = Schema.Struct({
	model: Schema.String,
	thinking: Schema.optional(ThinkingLevelSchema),
});

const AgentDefinitionFrontmatterSchema = Schema.Struct({
	name: Schema.String,
	description: Schema.String,
	models: Schema.NonEmptyArray(ModelSpecSchema),
	sandbox_fs: FilesystemModeSchema,
	sandbox_net: NetworkModeSchema,
	approval_policy: ApprovalPolicySchema,
	approval_timeout: ApprovalTimeoutSeconds,
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
		filesystemMode: parsedFrontmatter.sandbox_fs,
		networkMode: parsedFrontmatter.sandbox_net,
		approvalPolicy: parsedFrontmatter.approval_policy,
		approvalTimeoutSeconds: parsedFrontmatter.approval_timeout,
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

function findNearestProjectPiDir(cwd: string): string | null {
	let current = cwd;
	while (true) {
		const candidate = path.join(current, ".pi");
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch {
			// ignore
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export function loadAgentDefinition(name: string, cwd: string): AgentDefinition | null {
	const projectPi = findNearestProjectPiDir(cwd);
	const candidates: string[] = [];

	if (projectPi) {
		candidates.push(path.join(projectPi, "agents", `${name}.md`));
	}

	const userAgentsDir = path.join(os.homedir(), ".pi", "agent", "agents");
	candidates.push(path.join(userAgentsDir, `${name}.md`));

	// Extension-bundled fallback
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
