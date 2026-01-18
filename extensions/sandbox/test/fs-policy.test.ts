import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkWriteAllowed } from "../src/fs-policy.js";

describe("checkWriteAllowed", () => {
	const workspaceRoot = "/home/testuser/project";

	describe("danger-full-access mode", () => {
		it("allows writes anywhere", () => {
			const result = checkWriteAllowed({
				targetPath: "/etc/passwd",
				workspaceRoot,
				filesystemMode: "danger-full-access",
			});
			expect(result.allowed).toBe(true);
		});

		it("allows writes to .git/hooks", () => {
			const result = checkWriteAllowed({
				targetPath: path.join(workspaceRoot, ".git/hooks/pre-commit"),
				workspaceRoot,
				filesystemMode: "danger-full-access",
			});
			expect(result.allowed).toBe(true);
		});
	});

	describe("workspace-write mode", () => {
		it("allows writes under workspace root", () => {
			const result = checkWriteAllowed({
				targetPath: path.join(workspaceRoot, "src/file.ts"),
				workspaceRoot,
				filesystemMode: "workspace-write",
			});
			expect(result.allowed).toBe(true);
		});

		it("denies writes outside workspace root", () => {
			const result = checkWriteAllowed({
				targetPath: "/etc/passwd",
				workspaceRoot,
				filesystemMode: "workspace-write",
			});
			expect(result.allowed).toBe(false);
			expect(result).toHaveProperty("reason");
		});

		it("denies writes to .git/hooks", () => {
			const result = checkWriteAllowed({
				targetPath: path.join(workspaceRoot, ".git/hooks/pre-commit"),
				workspaceRoot,
				filesystemMode: "workspace-write",
			});
			expect(result.allowed).toBe(false);
			expect((result as any).reason).toContain(".git/hooks");
		});

		it("allows writes to temp directory", () => {
			const result = checkWriteAllowed({
				targetPath: "/tmp/test-file.txt",
				workspaceRoot,
				filesystemMode: "workspace-write",
			});
			expect(result.allowed).toBe(true);
		});
	});

	describe("read-only mode", () => {
		it("denies writes under workspace root", () => {
			const result = checkWriteAllowed({
				targetPath: path.join(workspaceRoot, "src/file.ts"),
				workspaceRoot,
				filesystemMode: "read-only",
			});
			expect(result.allowed).toBe(false);
		});

		it("allows writes to temp directory", () => {
			const result = checkWriteAllowed({
				targetPath: "/tmp/test-file.txt",
				workspaceRoot,
				filesystemMode: "read-only",
			});
			expect(result.allowed).toBe(true);
		});

		it("denies writes outside workspace", () => {
			const result = checkWriteAllowed({
				targetPath: "/home/testuser/other-project/file.ts",
				workspaceRoot,
				filesystemMode: "read-only",
			});
			expect(result.allowed).toBe(false);
		});
	});

	describe("integration with real paths", () => {
		let tempDir: string;

		beforeEach(() => {
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-test-"));
		});

		afterEach(() => {
			fs.rmSync(tempDir, { recursive: true, force: true });
		});

		it("handles symlinks correctly", () => {
			// Create a real file in temp
			const realFile = path.join(tempDir, "real.txt");
			fs.writeFileSync(realFile, "test");

			// Symlink to it
			const symlinkPath = path.join(tempDir, "link.txt");
			fs.symlinkSync(realFile, symlinkPath);

			// Should allow write to temp even via symlink
			const result = checkWriteAllowed({
				targetPath: symlinkPath,
				workspaceRoot: "/some/other/workspace",
				filesystemMode: "workspace-write",
			});
			expect(result.allowed).toBe(true);
		});

		it("handles non-existent paths", () => {
			const nonExistent = path.join(tempDir, "does-not-exist.txt");

			const result = checkWriteAllowed({
				targetPath: nonExistent,
				workspaceRoot: "/some/other/workspace",
				filesystemMode: "workspace-write",
			});
			// Should be allowed because parent is in temp
			expect(result.allowed).toBe(true);
		});
	});
});
