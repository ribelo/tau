import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SOURCE_ROOT = "src";
const ALLOWED_FILES = new Set([
	"src/app.ts",
	"src/agent/worker.ts",
	"src/services/footer.ts",
]);

/** @returns {string[]} */
function listTypeScriptFiles(dirPath) {
	const entries = readdirSync(dirPath);
	const files = [];

	for (const entry of entries) {
		const absolutePath = path.join(dirPath, entry);
		const stats = statSync(absolutePath);
		if (stats.isDirectory()) {
			files.push(...listTypeScriptFiles(absolutePath));
			continue;
		}

		if (absolutePath.endsWith(".ts")) {
			files.push(absolutePath);
		}
	}

	return files;
}

function main() {
	const sourceDir = path.resolve(SOURCE_ROOT);
	const files = listTypeScriptFiles(sourceDir);
	const violations = [];

	for (const file of files) {
		const relativePath = path.relative(process.cwd(), file).replaceAll(path.sep, "/");
		const lines = readFileSync(file, "utf8").split(/\r?\n/u);

		for (const [index, line] of lines.entries()) {
			if (!line.includes("Effect.runFork(")) {
				continue;
			}
			if (ALLOWED_FILES.has(relativePath)) {
				continue;
			}

			violations.push(`${relativePath}:${index + 1}`);
		}
	}

	if (violations.length === 0) {
		return;
	}

	console.error("Effect.runFork is restricted to approved modules:");
	for (const location of violations) {
		console.error(`  - ${location}`);
	}
	process.exitCode = 1;
}

main();

