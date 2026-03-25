import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { checkWriteAllowed } from "../src/sandbox/fs-policy.js";

const createdDirs: string[] = [];

function makeTempDir(prefix: string, baseDir?: string): string {
	const dir = fs.mkdtempSync(path.join(baseDir ?? os.tmpdir(), prefix));
	createdDirs.push(dir);
	return dir;
}

function expectDenied(
	result: ReturnType<typeof checkWriteAllowed>,
	expectedReasonPart: string,
): void {
	expect(result.allowed).toBe(false);
	if (result.allowed) {
		throw new Error("Expected denied result");
	}
	expect(result.reason).toContain(expectedReasonPart);
}

afterEach(() => {
	for (const dir of createdDirs.splice(0, createdDirs.length)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("checkWriteAllowed symlink hardening", () => {
	it("denies workspace symlink traversal outside workspace", () => {
		const workspaceRoot = makeTempDir("tau-fs-workspace-");
		const outsideRoot = makeTempDir("tau-fs-outside-");
		const escapeLink = path.join(workspaceRoot, "escape");
		fs.symlinkSync(outsideRoot, escapeLink);

		const result = checkWriteAllowed({
			targetPath: path.join(escapeLink, "nested", "file.txt"),
			workspaceRoot,
			filesystemMode: "workspace-write",
		});

		expectDenied(result, "resolves outside workspace root");
	});

	it("allows workspace symlink traversal that stays inside workspace", () => {
		const workspaceRoot = makeTempDir("tau-fs-workspace-");
		const safeDir = path.join(workspaceRoot, "safe");
		fs.mkdirSync(safeDir, { recursive: true });
		const safeLink = path.join(workspaceRoot, "safe-link");
		fs.symlinkSync(safeDir, safeLink);

		const result = checkWriteAllowed({
			targetPath: path.join(safeLink, "new-file.txt"),
			workspaceRoot,
			filesystemMode: "workspace-write",
		});

		expect(result).toEqual({ allowed: true });
	});

	it("denies read-only writes through temp symlink escaping allowed roots", () => {
		const workspaceRoot = makeTempDir("tau-fs-workspace-");
		const tempRoot = makeTempDir("tau-fs-temp-");
		const outsideRoot = makeTempDir("tau-fs-nontemp-", process.cwd());
		const escapeLink = path.join(tempRoot, "escape");
		fs.symlinkSync(outsideRoot, escapeLink);

		const result = checkWriteAllowed({
			targetPath: path.join(escapeLink, "file.txt"),
			workspaceRoot,
			filesystemMode: "read-only",
		});

		expectDenied(result, "resolves outside allowed writable roots");
	});

	it("denies .git writes through workspace symlink with missing descendants", () => {
		const workspaceRoot = makeTempDir("tau-fs-workspace-");
		const gitDir = path.join(workspaceRoot, ".git");
		fs.mkdirSync(gitDir, { recursive: true });
		const gitLink = path.join(workspaceRoot, "git-link");
		fs.symlinkSync(gitDir, gitLink);

		const result = checkWriteAllowed({
			targetPath: path.join(gitLink, "objects", "new-object"),
			workspaceRoot,
			filesystemMode: "workspace-write",
		});

		expectDenied(result, "Write to .git/");
	});

	it("allows read-only writes to regular temp paths", () => {
		const workspaceRoot = makeTempDir("tau-fs-workspace-");
		const tempRoot = makeTempDir("tau-fs-temp-");

		const result = checkWriteAllowed({
			targetPath: path.join(tempRoot, "regular-file.txt"),
			workspaceRoot,
			filesystemMode: "read-only",
		});

		expect(result).toEqual({ allowed: true });
	});
});
