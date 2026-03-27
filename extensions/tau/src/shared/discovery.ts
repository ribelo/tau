import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const EXTENSION_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);

export const EXTENSION_AGENTS_DIR = path.join(EXTENSION_ROOT, "agents");

export function getUserSettingsPath(): string {
	const override = process.env["TAU_SANDBOX_USER_SETTINGS_PATH"];
	if (override) return override;
	return path.join(os.homedir(), ".pi", "agent", "settings.json");
}

export function getUserAgentsDir(): string {
	return path.join(os.homedir(), ".pi", "agent", "agents");
}

export function getTauMemoryDir(): string {
	return path.join(os.homedir(), ".pi", "agent", "tau", "memories");
}

export function getProjectSettingsPath(projectPiDir: string): string {
	return path.join(projectPiDir, "settings.json");
}

export function findNearestProjectPiDir(cwd: string): string | null {
	let current = cwd;
	for (;;) {
		const candidate = path.join(current, ".pi");
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch {
			// not found at this level
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}
