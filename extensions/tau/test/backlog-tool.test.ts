import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runBacklogCommand } from "../src/backlog/tool.js";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tau-backlog-tool-"));
	tempDirs.push(dir);
	return dir;
}

describe("backlog tool", () => {
	it("supports create, update, show, close, and status commands", async () => {
		const workspaceRoot = await makeWorkspace();

		const created = await runBacklogCommand('create "Alpha" --id tau-1 --type task --priority 1', workspaceRoot);
		expect(created.ok).toBe(true);
		expect((created.data as { id: string }).id).toBe("tau-1");

		const updated = await runBacklogCommand('update tau-1 --title "Alpha updated" --notes "note"', workspaceRoot);
		expect(updated.ok).toBe(true);
		expect((updated.data as { title: string }).title).toBe("Alpha updated");

		const shown = await runBacklogCommand("show tau-1", workspaceRoot);
		expect(shown.ok).toBe(true);
		expect((shown.data as { notes?: string }).notes).toBe("note");

		const closed = await runBacklogCommand('close tau-1 --reason "Done"', workspaceRoot);
		expect(closed.ok).toBe(true);
		expect((closed.data as { status?: string }).status).toBe("closed");

		const status = await runBacklogCommand("status", workspaceRoot);
		expect(status.ok).toBe(true);
		expect((status.data as { total_issues: number; closed_issues: number }).total_issues).toBe(1);
		expect((status.data as { total_issues: number; closed_issues: number }).closed_issues).toBe(1);
	});

	it("supports dependency, comment, ready, and blocked commands", async () => {
		const workspaceRoot = await makeWorkspace();

		await runBacklogCommand('create "Blocker" --id tau-1', workspaceRoot);
		await runBacklogCommand('create "Blocked" --id tau-2', workspaceRoot);
		await runBacklogCommand('dep add tau-2 tau-1 --type blocks', workspaceRoot);
		await runBacklogCommand('comment tau-2 "needs review"', workspaceRoot);

		const blocked = await runBacklogCommand("blocked", workspaceRoot);
		expect(blocked.ok).toBe(true);
		expect((blocked.data as Array<{ id: string }>).map((issue) => issue.id)).toEqual(["tau-2"]);

		const ready = await runBacklogCommand("ready", workspaceRoot);
		expect(ready.ok).toBe(true);
		expect((ready.data as Array<{ id: string }>).map((issue) => issue.id)).toEqual(["tau-1"]);

		const comments = await runBacklogCommand("comments tau-2", workspaceRoot);
		expect(comments.ok).toBe(true);
		expect((comments.data as Array<{ text: string }>)[0]?.text).toBe("needs review");

		const depTree = await runBacklogCommand("dep tree tau-2 --direction up", workspaceRoot);
		expect(depTree.ok).toBe(true);
		expect((depTree.data as Array<{ id: string; depth: number }>).map((node) => [node.id, node.depth])).toEqual([
			["tau-2", 0],
			["tau-1", 1],
		]);
	});

	it("rejects adding a new task under a closed epic with a clear error", async () => {
		const workspaceRoot = await makeWorkspace();

		await runBacklogCommand('create "Platform epic" --id tau-epic --type epic', workspaceRoot);
		await runBacklogCommand('close tau-epic --reason "Done"', workspaceRoot);
		await runBacklogCommand('create "Follow-up task" --id tau-task --type task', workspaceRoot);

		const result = await runBacklogCommand("dep add tau-task tau-epic --type parent-child", workspaceRoot);

		expect(result.ok).toBe(false);
		expect(result.outputText).toContain("closed epic");
		expect(result.outputText).toContain("tau-epic");
	});
});
