import * as fs from "node:fs";
import * as path from "node:path";
import type { ForgeState } from "./types.js";

const FORGE_DIR = ".pi/forge";

function ensureDir(filePath: string): void {
	const dir = path.dirname(filePath);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** Root directory for all forge state. */
export function forgeDir(cwd: string): string {
	return path.resolve(cwd, FORGE_DIR);
}

/** Path to a specific forge's state file. */
export function statePath(cwd: string, taskId: string): string {
	return path.join(forgeDir(cwd), taskId, "state.json");
}

/** Load a forge state by task ID. Returns undefined if not found. */
export function loadState(cwd: string, taskId: string): ForgeState | undefined {
	const fp = statePath(cwd, taskId);
	try {
		const content = fs.readFileSync(fp, "utf-8");
		return JSON.parse(content) as ForgeState;
	} catch {
		return undefined;
	}
}

/** Save forge state atomically. */
export function saveState(cwd: string, state: ForgeState): void {
	const fp = statePath(cwd, state.taskId);
	ensureDir(fp);
	const tmp = `${fp}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
	fs.renameSync(tmp, fp);
}

/** Delete a forge's state directory. */
export function deleteForge(cwd: string, taskId: string): void {
	const dir = path.join(forgeDir(cwd), taskId);
	if (fs.existsSync(dir)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** List all forge states. */
export function listForges(cwd: string): ForgeState[] {
	const root = forgeDir(cwd);
	if (!fs.existsSync(root)) return [];
	const entries = fs.readdirSync(root, { withFileTypes: true });
	const states: ForgeState[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const state = loadState(cwd, entry.name);
		if (state) states.push(state);
	}
	return states;
}

/** Find the currently active forge, if any. */
export function findActiveForge(cwd: string): ForgeState | undefined {
	return listForges(cwd).find((s) => s.status === "active");
}
