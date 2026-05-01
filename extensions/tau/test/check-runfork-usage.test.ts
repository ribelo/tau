import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";
import { findRunForkUsages } from "../scripts/check-runfork-usage.mjs";

const THIS_FILE = fileURLToPath(import.meta.url);
const EXTENSION_ROOT = path.resolve(path.dirname(THIS_FILE), "..");
const CHECKER_SCRIPT_PATH = path.join(EXTENSION_ROOT, "scripts/check-runfork-usage.mjs");

type CheckerResult = {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
};

const writeSourceFile = (workspace: string, relativePath: string, content: string): void => {
	const absolutePath = path.join(workspace, relativePath);
	mkdirSync(path.dirname(absolutePath), { recursive: true });
	writeFileSync(absolutePath, content, "utf8");
};

const runChecker = (workspace: string): CheckerResult => {
	const result = spawnSync("node", [CHECKER_SCRIPT_PATH], {
		cwd: workspace,
		encoding: "utf8",
	});
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
	};
};

const checkerOutput = (result: CheckerResult): string => `${result.stderr}${result.stdout}`;

const createWorkspace = (): string => mkdtempSync(path.join(tmpdir(), "tau-runfork-check-"));

describe("check-runfork-usage script", () => {
	it("flags Effect.runFork via aliased Effect import", () => {
		const workspace = createWorkspace();
		try {
			const source = [
				'import { Effect as Fx } from "effect";',
				"Fx.runFork(Effect.void);",
			].join("\n");
			writeSourceFile(
				workspace,
				"src/feature.ts",
				source,
			);

			expect(findRunForkUsages(source, "src/feature.ts").map((usage) => usage.line)).toEqual([2]);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("flags bracket-member runFork access", () => {
		const workspace = createWorkspace();
		try {
			const source = [
				'import { Effect } from "effect";',
				'Effect["runFork"](Effect.void);',
			].join("\n");
			writeSourceFile(
				workspace,
				"src/feature.ts",
				source,
			);

			expect(findRunForkUsages(source, "src/feature.ts").map((usage) => usage.line)).toEqual([2]);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("flags calls through aliases assigned from Effect.runFork", () => {
		const workspace = createWorkspace();
		try {
			const source = [
				'import { Effect } from "effect";',
				"const fork = Effect.runFork;",
				"fork(Effect.void);",
			].join("\n");
			writeSourceFile(
				workspace,
				"src/feature.ts",
				source,
			);

			expect(findRunForkUsages(source, "src/feature.ts").map((usage) => usage.line)).toEqual([3]);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("rejects direct runFork usage in src/agent/worker.ts", () => {
		const workspace = createWorkspace();
		try {
			const source = [
				'import { Effect } from "effect";',
				"Effect.runFork(Effect.void);",
			].join("\n");
			writeSourceFile(
				workspace,
				"src/agent/worker.ts",
				source,
			);

			expect(findRunForkUsages(source, "src/agent/worker.ts").map((usage) => usage.line)).toEqual([2]);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("allows direct runFork usage in src/app.ts", () => {
		const workspace = createWorkspace();
		try {
			writeSourceFile(
				workspace,
				"src/app.ts",
				[
					'import { Effect } from "effect";',
					"Effect.runFork(Effect.void);",
				].join("\n"),
			);

			const result = runChecker(workspace);

			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});
});
