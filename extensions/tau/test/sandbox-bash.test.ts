import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { wrapCommandWithSandbox } from "../src/sandbox/bash.js";

function makeTempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("wrapCommandWithSandbox mount order", () => {
	it("binds siblings of .pi/ralph/tasks as read-only and tasks as writable", async () => {
		const workspaceRoot = makeTempDir("tau-sandbox-bwrap-");
		fs.mkdirSync(path.join(workspaceRoot, ".pi", "ralph", "tasks"), { recursive: true });
		fs.writeFileSync(path.join(workspaceRoot, ".pi", "settings.json"), "{}", "utf-8");

		const result = await wrapCommandWithSandbox({
			command: "echo hello",
			workspaceRoot,
			filesystemMode: "workspace-write",
			networkMode: "deny",
		});

		expect(result.success).toBe(true);
		if (!result.success) return;

		const parts = result.wrappedCommand.split(" ");
		const settingsPath = path.join(workspaceRoot, ".pi", "settings.json");
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

		const settingsRoBindIndex = findRoBindIndex(settingsPath);
		const tasksBindIndex = findBindIndex(tasksPath);

		expect(settingsRoBindIndex).toBeGreaterThan(-1);
		expect(tasksBindIndex).toBeGreaterThan(-1);
		expect(tasksBindIndex).toBeGreaterThan(settingsRoBindIndex);
	});

	it("does not add a bind for .pi/ralph/tasks when it does not exist", async () => {
		const workspaceRoot = makeTempDir("tau-sandbox-bwrap-");
		fs.mkdirSync(path.join(workspaceRoot, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(workspaceRoot, ".pi", "settings.json"), "{}", "utf-8");

		const result = await wrapCommandWithSandbox({
			command: "echo hello",
			workspaceRoot,
			filesystemMode: "workspace-write",
			networkMode: "deny",
		});

		expect(result.success).toBe(true);
		if (!result.success) return;

		const parts = result.wrappedCommand.split(" ");
		const tasksPath = path.join(workspaceRoot, ".pi", "ralph", "tasks");
		const tasksBindIndex = parts.indexOf(tasksPath);

		expect(tasksBindIndex).toBe(-1);
	});
});
