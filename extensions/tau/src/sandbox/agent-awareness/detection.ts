import * as path from "node:path";

import { safeRealpath } from "../../shared/fs.js";

function normalizeForCompare(p: string): string {
	const rp = safeRealpath(p);
	return rp.replace(/\/+$/, "");
}

function isSameOrAncestor(ancestor: string, child: string): boolean {
	const a = normalizeForCompare(ancestor);
	const c = normalizeForCompare(child);
	if (a === c) return true;
	const rel = path.relative(a, c);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function isOverlapping(
	ourCwd: string,
	ourGitRoot: string | null,
	theirCwd: string,
): boolean {
	const our = normalizeForCompare(ourCwd);
	const theirs = normalizeForCompare(theirCwd);

	if (isSameOrAncestor(our, theirs) || isSameOrAncestor(theirs, our)) return true;

	if (ourGitRoot) {
		const root = normalizeForCompare(ourGitRoot);
		if (isSameOrAncestor(root, theirs)) return true;
	}

	return false;
}
