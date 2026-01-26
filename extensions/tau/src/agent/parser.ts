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
	FILESYSTEM_MODES,
	migrateApprovalPolicy,
	migrateNetworkMode,
} from "../shared/policy.js";

import { isRecord } from "../shared/json.js";

const EXTENSION_AGENTS_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"agents",
);

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
	const reasoning_effort = frontmatter["reasoning_effort"];
	const sandbox_policy = frontmatter["sandbox_policy"];
	const network_mode = frontmatter["network_mode"];
	const approval_policy = frontmatter["approval_policy"];
	const approval_timeout = frontmatter["approval_timeout"];

	if (typeof name !== "string") {
		throw new Error("Invalid agent definition: 'name' is required and must be a string");
	}
	if (typeof description !== "string") {
		throw new Error("Invalid agent definition: 'description' is required and must be a string");
	}

	const sandbox: SandboxConfig = {};
	if (typeof sandbox_policy === "string" && FILESYSTEM_MODES.includes(sandbox_policy as FilesystemMode)) {
		sandbox.filesystemMode = sandbox_policy as FilesystemMode;
	}
	if (typeof network_mode === "string") {
		const nm = migrateNetworkMode(network_mode);
		if (nm) sandbox.networkMode = nm;
	}
	if (typeof approval_policy === "string") {
		const ap = migrateApprovalPolicy(approval_policy);
		if (ap) sandbox.approvalPolicy = ap;
	}
	if (typeof approval_timeout === "number") {
		sandbox.approvalTimeoutSeconds = approval_timeout;
	}

	return {
		name,
		description,
		model: model === "inherit" ? "inherit" : typeof model === "string" ? model : undefined,
		thinking: (thinking ?? reasoning_effort) as ThinkingLevel | undefined,
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
