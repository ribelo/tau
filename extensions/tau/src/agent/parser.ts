import { parse } from "yaml";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import type { AgentDefinition } from "./types.js";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { SandboxConfig } from "../sandbox/config.js";
import {
	type FilesystemMode,
	type NetworkMode,
	APPROVAL_POLICIES,
	FILESYSTEM_MODES,
	NETWORK_MODES,
} from "../shared/policy.js";

import { isRecord } from "../shared/json.js";

const EXTENSION_AGENTS_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"agents",
);

const THINKING_LEVELS = ["low", "medium", "high"] as const;

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

	if (!isRecord(frontmatter)) {
		throw new Error("Invalid agent definition: Frontmatter is not an object");
	}

	const name = frontmatter["name"];
	const description = frontmatter["description"];
	const model = frontmatter["model"];
	const thinking = frontmatter["thinking"];
	const sandbox_fs = frontmatter["sandbox_fs"];
	const sandbox_net = frontmatter["sandbox_net"];
	const approval_policy = frontmatter["approval_policy"];
	const approval_timeout = frontmatter["approval_timeout"];

	if (typeof name !== "string") {
		throw new Error("Invalid agent definition: 'name' is required and must be a string");
	}
	if (typeof description !== "string") {
		throw new Error("Invalid agent definition: 'description' is required and must be a string");
	}

	if (typeof model !== "string") {
		throw new Error("Invalid agent definition: 'model' is required and must be a string");
	}
	if (typeof thinking !== "string") {
		throw new Error("Invalid agent definition: 'thinking' is required and must be a string");
	}
	if (thinking !== "inherit" && !THINKING_LEVELS.includes(thinking as (typeof THINKING_LEVELS)[number])) {
		throw new Error("Invalid agent definition: 'thinking' must be one of low, medium, high, inherit");
	}
	if (typeof sandbox_fs !== "string" || !FILESYSTEM_MODES.includes(sandbox_fs as FilesystemMode)) {
		throw new Error(
			"Invalid agent definition: 'sandbox_fs' is required and must be one of read-only, workspace-write, danger-full-access",
		);
	}
	if (typeof sandbox_net !== "string" || !NETWORK_MODES.includes(sandbox_net as NetworkMode)) {
		throw new Error("Invalid agent definition: 'sandbox_net' is required and must be one of deny, allow-all");
	}
	if (
		typeof approval_policy !== "string" ||
		!APPROVAL_POLICIES.includes(approval_policy as (typeof APPROVAL_POLICIES)[number])
	) {
		throw new Error(
			"Invalid agent definition: 'approval_policy' is required and must be one of never, on-failure, on-request, unless-trusted",
		);
	}
	if (typeof approval_timeout !== "number" || Number.isNaN(approval_timeout)) {
		throw new Error("Invalid agent definition: 'approval_timeout' is required and must be a number");
	}

	const sandbox: SandboxConfig = {
		filesystemMode: sandbox_fs as FilesystemMode,
		networkMode: sandbox_net as NetworkMode,
		approvalPolicy: approval_policy as (typeof APPROVAL_POLICIES)[number],
		approvalTimeoutSeconds: approval_timeout,
	};

	return {
		name,
		description,
		model: model === "inherit" ? "inherit" : model,
		thinking: thinking === "inherit" ? "inherit" : (thinking as ThinkingLevel),
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
