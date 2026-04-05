import * as fs from "node:fs";
import * as path from "node:path";

export interface AutoresearchConfig {
	maxIterations?: number | undefined;
	workingDir?: string | undefined;
}

function isENOENT(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function readAutoresearchConfig(content: string): AutoresearchConfig {
	const parsed = JSON.parse(content) as unknown;
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error("autoresearch.config.json must contain an object");
	}
	const candidate = parsed as { maxIterations?: unknown; workingDir?: unknown };
	const config: AutoresearchConfig = {};
	if ("maxIterations" in candidate) {
		if (typeof candidate.maxIterations !== "number" || !Number.isFinite(candidate.maxIterations)) {
			throw new Error("autoresearch.config.json: maxIterations must be a finite number");
		}
		config.maxIterations = Math.max(0, Math.floor(candidate.maxIterations));
	}
	if ("workingDir" in candidate) {
		if (typeof candidate.workingDir !== "string") {
			throw new Error("autoresearch.config.json: workingDir must be a string");
		}
		if (candidate.workingDir.length > 0) {
			config.workingDir = candidate.workingDir;
		}
	}
	return config;
}

export function readAutoresearchConfigSafe(content: string): AutoresearchConfig {
	try {
		return readAutoresearchConfig(content);
	} catch {
		throw new Error("Invalid autoresearch.config.json. Ensure it is valid JSON with an object containing optional maxIterations (number) and workingDir (string).");
	}
}

export function loadAutoresearchConfig(cwd: string): { config: AutoresearchConfig; error: string | null } {
	const configPath = path.join(cwd, "autoresearch.config.json");
	try {
		const content = fs.readFileSync(configPath, "utf-8");
		return { config: readAutoresearchConfigSafe(content), error: null };
	} catch (error) {
		if (isENOENT(error)) {
			return { config: {}, error: null };
		}
		return { config: {}, error: String(error) };
	}
}

export function resolveWorkDir(ctxCwd: string, config: AutoresearchConfig): string {
	if (!config.workingDir) return ctxCwd;
	return path.isAbsolute(config.workingDir)
		? path.normalize(config.workingDir)
		: path.resolve(ctxCwd, config.workingDir);
}

export function resolveMaxExperiments(config: AutoresearchConfig): number | null {
	if (typeof config.maxIterations === "number" && config.maxIterations > 0) {
		return Math.floor(config.maxIterations);
	}
	return null;
}
