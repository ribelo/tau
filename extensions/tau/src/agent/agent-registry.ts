/**
 * AgentRegistry - discovers and loads agent definitions from .md files
 * 
 * Search paths (in priority order):
 * 1. Project: .pi/agents/*.md
 * 2. User: ~/.pi/agent/agents/*.md
 * 3. Extension: extensions/tau/agents/*.md (bundled)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import type { AgentDefinition, Complexity } from "./types.js";
import { parseAgentDefinition } from "./parser.js";

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
			const name = file.slice(0, -3); // Remove .md extension
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

export interface AgentSummary {
	readonly name: string;
	readonly description: string;
}

export class AgentRegistry {
	// Map of agent name -> file path (priority-resolved)
	private readonly agentPaths: Map<string, string>;
	// Cache of loaded definitions
	private readonly cache: Map<string, AgentDefinition>;

	private constructor(agentPaths: Map<string, string>) {
		this.agentPaths = agentPaths;
		this.cache = new Map();
	}

	/**
	 * Create an AgentRegistry that discovers agents from all search paths.
	 * Later paths have lower priority (project > user > extension).
	 */
	static load(cwd: string): AgentRegistry {
		const merged = new Map<string, string>();

		// 1. Extension agents (lowest priority - loaded first, can be overridden)
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

		return new AgentRegistry(merged);
	}

	/**
	 * Get an agent definition by name.
	 * Returns undefined if the agent doesn't exist.
	 */
	get(name: string): AgentDefinition | undefined {
		// Check cache first
		const cached = this.cache.get(name);
		if (cached) return cached;

		// Find and load
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

	/**
	 * Check if an agent exists by name.
	 */
	has(name: string): boolean {
		return this.agentPaths.has(name);
	}

	/**
	 * List all available agent names.
	 */
	names(): string[] {
		return Array.from(this.agentPaths.keys()).sort();
	}

	/**
	 * List all agents with summary info (lazy-loads definitions).
	 */
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
	 * Returns the full definition with resolved model/thinking settings.
	 */
	resolve(name: string, _complexity: Complexity): AgentDefinition | undefined {
		const def = this.get(name);
		if (!def) return undefined;

		// For now, complexity doesn't affect agent definitions
		// (they specify their own model/thinking or inherit)
		// Future: could add per-complexity model overrides in frontmatter
		return def;
	}
}
