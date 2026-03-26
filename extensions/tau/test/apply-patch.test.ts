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
			expect(summary).toEqual({ added: ["hello.txt"], modified: [], deleted: [] });
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
			expect(summary).toEqual({ added: [], modified: ["dst.txt"], deleted: [] });
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
			expect(summary).toEqual({ added: [], modified: [], deleted: ["dead.txt"] });
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
});
