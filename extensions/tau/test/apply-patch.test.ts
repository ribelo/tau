import { describe, expect, it } from "vitest";

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { __test__ } from "../src/sandbox/apply-patch.js";

async function withTempDir<A>(fn: (dir: string) => Promise<A>): Promise<A> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tau-apply-patch-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("apply_patch", () => {
	it("adds a new file", async () => {
		await withTempDir(async (cwd) => {
			const operations = __test__.rewriteInputToOperations(
				cwd,
				[
					"*** Begin Patch",
					"*** Add File: hello.txt",
					"+hello",
					"+world",
					"*** End Patch",
				].join("\n"),
			);

			const summary = await __test__.applyResolvedPatch(operations, cwd);
			expect(summary.added).toEqual(["hello.txt"]);
			expect(summary.modified).toEqual([]);
			expect(summary.deleted).toEqual([]);
			expect(summary.diffs).toHaveLength(1);
			expect(summary.diffs[0]?.filePath).toBe("hello.txt");
			expect(await fs.readFile(path.join(cwd, "hello.txt"), "utf8")).toBe("hello\nworld\n");
		});
	});

	it("updates and moves a file", async () => {
		await withTempDir(async (cwd) => {
			await fs.writeFile(path.join(cwd, "src.txt"), "line\n", "utf8");

			const operations = __test__.rewriteInputToOperations(
				cwd,
				[
					"*** Begin Patch",
					"*** Update File: src.txt",
					"*** Move to: dst.txt",
					"@@",
					"-line",
					"+line2",
					"*** End Patch",
				].join("\n"),
			);

			const summary = await __test__.applyResolvedPatch(operations, cwd);
			expect(summary.added).toEqual([]);
			expect(summary.modified).toEqual(["dst.txt"]);
			expect(summary.deleted).toEqual([]);
			expect(summary.diffs).toHaveLength(1);
			expect(summary.diffs[0]?.filePath).toBe("dst.txt");
			expect(await fs.readFile(path.join(cwd, "dst.txt"), "utf8")).toBe("line2\n");
			await expect(fs.stat(path.join(cwd, "src.txt"))).rejects.toThrow();
		});
	});

	it("deletes a file", async () => {
		await withTempDir(async (cwd) => {
			await fs.writeFile(path.join(cwd, "dead.txt"), "gone\n", "utf8");

			const operations = __test__.rewriteInputToOperations(
				cwd,
				[
					"*** Begin Patch",
					"*** Delete File: dead.txt",
					"*** End Patch",
				].join("\n"),
			);

			const summary = await __test__.applyResolvedPatch(operations, cwd);
			expect(summary.added).toEqual([]);
			expect(summary.modified).toEqual([]);
			expect(summary.deleted).toEqual(["dead.txt"]);
			expect(summary.diffs).toHaveLength(1);
			expect(summary.diffs[0]?.filePath).toBe("dead.txt");
			await expect(fs.stat(path.join(cwd, "dead.txt"))).rejects.toThrow();
		});
	});

	it("fails fast on invalid absolute paths", async () => {
		await withTempDir(async (cwd) => {
			expect(() =>
				__test__.rewriteInputToOperations(
					cwd,
					[
						"*** Begin Patch",
						"*** Add File: /tmp/nope.txt",
						"+bad",
						"*** End Patch",
					].join("\n"),
				),
			).toThrow(/file paths must be relative/);
		});
	});

	it("preserves leading @ in scoped-package paths", async () => {
		await withTempDir(async (cwd) => {
			const operations = __test__.rewriteInputToOperations(
				cwd,
				[
					"*** Begin Patch",
					"*** Add File: @types/node/index.d.ts",
					"+declare module 'node';",
					"*** End Patch",
				].join("\n"),
			);

			const summary = await __test__.applyResolvedPatch(operations, cwd);
			expect(summary.added).toEqual(["@types/node/index.d.ts"]);
			expect(summary.modified).toEqual([]);
			expect(summary.deleted).toEqual([]);
			expect(summary.diffs).toHaveLength(1);
			expect(summary.diffs[0]?.filePath).toBe("@types/node/index.d.ts");
			expect(
				await fs.readFile(path.join(cwd, "@types/node/index.d.ts"), "utf8"),
			).toBe("declare module 'node';\n");
		});
	});

	it("inserts lines at context position, not EOF", async () => {
		await withTempDir(async (cwd) => {
			await fs.writeFile(
				path.join(cwd, "src.ts"),
				["import { a } from 'a';", "", "const x = 1;", ""].join("\n"),
				"utf8",
			);

			const operations = __test__.rewriteInputToOperations(
				cwd,
				[
					"*** Begin Patch",
					"*** Update File: src.ts",
					"@@ import { a } from 'a';",
					"+import { b } from 'b';",
					"*** End Patch",
				].join("\n"),
			);

			const summary = await __test__.applyResolvedPatch(operations, cwd);
			expect(summary.modified).toEqual(["src.ts"]);
			const contents = await fs.readFile(path.join(cwd, "src.ts"), "utf8");
			const lines = contents.split("\n");
			expect(lines[1]).toBe("import { b } from 'b';");
		});
	});

	it("rejects add-file when target already exists", async () => {
		await withTempDir(async (cwd) => {
			await fs.writeFile(path.join(cwd, "existing.txt"), "original\n", "utf8");

			const operations = __test__.rewriteInputToOperations(
				cwd,
				[
					"*** Begin Patch",
					"*** Add File: existing.txt",
					"+overwritten",
					"*** End Patch",
				].join("\n"),
			);

			await expect(__test__.applyResolvedPatch(operations, cwd)).rejects.toThrow(
				/file already exists/,
			);
			expect(await fs.readFile(path.join(cwd, "existing.txt"), "utf8")).toBe("original\n");
		});
	});
});
