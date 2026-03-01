import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord, type AnyRecord } from "./json.js";

export type JsonFileReadResult =
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
