import * as os from "node:os";
import * as path from "node:path";

export function dreamTranscriptRoot(cwd: string): string {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return path.join(getPiAgentDir(), "sessions", safePath);
}

function getPiAgentDir(): string {
	const envDir = process.env["PI_CODING_AGENT_DIR"];
	if (envDir === undefined) {
		return path.join(os.homedir(), ".pi", "agent");
	}

	if (envDir === "~") {
		return os.homedir();
	}

	if (envDir.startsWith("~/")) {
		return path.join(os.homedir(), envDir.slice(2));
	}

	return envDir;
}

export function isDreamTranscriptFile(fileName: string): boolean {
	return fileName.endsWith(".jsonl");
}

export function parseDreamTranscriptSessionId(filePath: string): string | null {
	const baseName = path.basename(filePath, ".jsonl");
	const separatorIndex = baseName.indexOf("_");

	if (separatorIndex <= 0 || separatorIndex >= baseName.length - 1) {
		return null;
	}

	return baseName.slice(separatorIndex + 1);
}
