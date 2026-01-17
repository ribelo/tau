import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface LoadedSkill {
	name: string;
	path: string;
	contents: string;
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

const EXTENSION_SKILLS_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"skills",
);

function tryReadUtf8(p: string): string | null {
	try {
		return fs.readFileSync(p, "utf-8");
	} catch {
		return null;
	}
}

export function loadSkill(name: string, cwd: string): LoadedSkill | null {
	const projectPi = findNearestProjectPiDir(cwd);
	const candidates: string[] = [];

	if (projectPi) {
		candidates.push(path.join(projectPi, "skills", name, "SKILL.md"));
		candidates.push(path.join(projectPi, "skills", `${name}.md`));
	}

	const userSkillsDir = path.join(os.homedir(), ".pi", "agent", "skills");
	candidates.push(path.join(userSkillsDir, name, "SKILL.md"));
	candidates.push(path.join(userSkillsDir, `${name}.md`));

	// Extension-bundled fallback
	candidates.push(path.join(EXTENSION_SKILLS_DIR, name, "SKILL.md"));
	candidates.push(path.join(EXTENSION_SKILLS_DIR, `${name}.md`));

	for (const filePath of candidates) {
		if (!isFile(filePath)) continue;
		const contents = tryReadUtf8(filePath);
		if (contents === null) continue;
		return { name, path: filePath, contents };
	}

	return null;
}

export function loadSkills(names: string[], cwd: string): { loaded: LoadedSkill[]; missing: string[] } {
	const loaded: LoadedSkill[] = [];
	const missing: string[] = [];

	for (const name of names) {
		const trimmed = name.trim();
		if (!trimmed) continue;
		const skill = loadSkill(trimmed, cwd);
		if (skill) loaded.push(skill);
		else missing.push(trimmed);
	}

	return { loaded, missing };
}
