import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord, type AnyRecord } from "./json.js";

export function readJsonFile(filePath: string): AnyRecord | null {
	try {
		if (!fs.existsSync(filePath)) return null;
		const raw = fs.readFileSync(filePath, "utf-8");
		const json = JSON.parse(raw);
		return isRecord(json) ? json : null;
	} catch {
		return null;
	}
}

export function writeJsonFile(filePath: string, obj: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + "\n", "utf-8");
}
