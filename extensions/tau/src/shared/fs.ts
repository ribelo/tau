import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isRecord, type AnyRecord } from "./json.js";

type JsonFileReadResult =
	| { readonly _tag: "missing" }
	| { readonly _tag: "invalid"; readonly reason: string }
	| { readonly _tag: "ok"; readonly data: AnyRecord };

export function readJsonFileDetailed(filePath: string): JsonFileReadResult {
	if (!fs.existsSync(filePath)) {
		return { _tag: "missing" };
	}

	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const json: unknown = JSON.parse(raw);
		if (!isRecord(json)) {
			return { _tag: "invalid", reason: "top-level JSON value must be an object" };
		}
		return { _tag: "ok", data: json };
	} catch (error) {
		return {
			_tag: "invalid",
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

export function readJsonFile(filePath: string): AnyRecord | null {
	const result = readJsonFileDetailed(filePath);
	return result._tag === "ok" ? result.data : null;
}

export function writeJsonFile(filePath: string, obj: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + "\n", "utf-8");
}

export function safeRealpath(targetPath: string): string {
	const absolute = path.isAbsolute(targetPath) ? targetPath : path.resolve(targetPath);
	try {
		return fs.realpathSync(absolute);
	} catch {
		const parent = path.dirname(absolute);
		const filename = path.basename(absolute);
		try {
			return path.join(fs.realpathSync(parent), filename);
		} catch {
			return absolute;
		}
	}
}

export function isPathInsideRoot(targetPath: string, root: string): boolean {
	const resolved = safeRealpath(targetPath);
	const resolvedRoot = safeRealpath(root);
	const normalizedTarget = path.normalize(resolved);
	const normalizedRoot = path.normalize(resolvedRoot);

	return (
		normalizedTarget === normalizedRoot ||
		normalizedTarget.startsWith(normalizedRoot + path.sep)
	);
}

export function collectTempRoots(): readonly string[] {
	const tempRoots = new Set<string>();

	const addPath = (candidate: string) => {
		tempRoots.add(candidate);
		try {
			tempRoots.add(fs.realpathSync(candidate));
		} catch {
			// Ignore missing or inaccessible temp roots.
		}
	};

	addPath("/tmp");
	addPath(os.tmpdir());

	const envTmpDir = process.env["TMPDIR"];
	if (envTmpDir) {
		addPath(envTmpDir);
	}

	return Array.from(tempRoots);
}
