import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { wrapCommandWithSandbox } from "../src/sandbox/bash.js";

function makeTempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("wrapCommandWithSandbox mount order", () => {
	it("binds .pi as read-only and .pi/ralph/tasks as writable in workspace-write mode", async () => {
		const workspaceRoot = makeTempDir("tau-sandbox-bwrap-");
		fs.mkdirSync(path.join(workspaceRoot, ".pi", "ralph", "tasks"), { recursive: true });

		const result = await wrapCommandWithSandbox({
			command: "echo hello",
			workspaceRoot,
			filesystemMode: "workspace-write",
			networkMode: "deny",
		});

		expect(result.success).toBe(true);
		if (!result.success) return;

		const parts = result.wrappedCommand.split(" ");
		const piPath = path.join(workspaceRoot, ".pi");
		const tasksPath = path.join(workspaceRoot, ".pi", "ralph", "tasks");

		function findRoBindIndex(targetPath: string): number {
			for (let i = 0; i < parts.length - 1; i++) {
				if (parts[i] === "--ro-bind" && parts[i + 1] === targetPath) {
					return i;
				}
			}
			return -1;
		}

		function findBindIndex(targetPath: string): number {
			for (let i = 0; i < parts.length - 1; i++) {
				if (parts[i] === "--bind" && parts[i + 1] === targetPath) {
					return i;
				}
			}
			return -1;
		}

		const piRoBindIndex = findRoBindIndex(piPath);
		const tasksBindIndex = findBindIndex(tasksPath);

		expect(piRoBindIndex).toBeGreaterThan(-1);
		expect(tasksBindIndex).toBeGreaterThan(-1);
		expect(tasksBindIndex).toBeGreaterThan(piRoBindIndex);
	});
});
