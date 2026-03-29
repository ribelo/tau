import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
	addIssueComment,
	addIssueDependency,
	createIssue,
	importBeadsIfNeeded,
	removeIssueDependency,
	setIssueStatus,
	updateIssueFields,
} from "../src/backlog/events.js";
import { resolveBacklogPaths } from "../src/backlog/contract.js";
import {
	readBacklogEventsFromWorkspace,
	readMaterializedIssuesCache,
	setBacklogLockTestHooksForTesting,
} from "../src/backlog/materialize.js";

const tempDirs: string[] = [];

afterEach(async () => {
	setBacklogLockTestHooksForTesting(null);
	await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tau-backlog-events-"));
	tempDirs.push(dir);
	return dir;
}

describe("backlog events", () => {
	it("writes immutable event files for create, update, status, dependency, and comment mutations", async () => {
		const workspaceRoot = await makeWorkspace();

		const created = await createIssue(workspaceRoot, {
			title: "Initial",
			actor: "alice",
			id: "tau-1",
			recorded_at: "2026-03-29T12:00:00.000Z",
		});
		expect(created.id).toBe("tau-1");

		await updateIssueFields(
			workspaceRoot,
			"tau-1",
			"alice",
			{ title: "Changed" },
			{ recorded_at: "2026-03-29T12:01:00.000Z" },
		);
		await setIssueStatus(workspaceRoot, {
			issueId: "tau-1",
			actor: "alice",
			status: "in_progress",
			recorded_at: "2026-03-29T12:02:00.000Z",
		});

		await createIssue(workspaceRoot, {
			title: "Blocker",
			actor: "alice",
			id: "tau-2",
			recorded_at: "2026-03-29T12:02:30.000Z",
		});

		await addIssueDependency(workspaceRoot, {
			issueId: "tau-1",
			actor: "alice",
			dependsOnId: "tau-2",
			type: "blocks",
			recorded_at: "2026-03-29T12:03:00.000Z",
		});
		await addIssueComment(workspaceRoot, {
			issueId: "tau-1",
			actor: "alice",
			text: "hello",
			recorded_at: "2026-03-29T12:04:00.000Z",
		});

		const events = await readBacklogEventsFromWorkspace(workspaceRoot);
		expect(events).toHaveLength(6);
		expect(events.map((event) => event.kind)).toEqual([
			"issue.created",
			"issue.updated",
			"issue.updated",
			"issue.created",
			"issue.updated",
			"issue.updated",
		]);

		const paths = resolveBacklogPaths(workspaceRoot);
		const cached = await readMaterializedIssuesCache(workspaceRoot);
		const issue = cached.find((entry) => entry.id === "tau-1");
		expect(issue?.title).toBe("Changed");
		expect(issue?.status).toBe("in_progress");
		expect(issue?.dependencies?.[0]?.depends_on_id).toBe("tau-2");
		expect(issue?.comments?.[0]?.text).toBe("hello");
		expect(await fs.readFile(paths.materializedIssuesPath, "utf8")).toContain("tau-1");
	});

	it("imports .beads/issues.jsonl on first use and preserves ids and dependencies", async () => {
		const workspaceRoot = await makeWorkspace();
		const beadsDir = path.join(workspaceRoot, ".beads");
		await fs.mkdir(beadsDir, { recursive: true });
		await fs.writeFile(
			path.join(beadsDir, "issues.jsonl"),
			[
				JSON.stringify({
					id: "tau-legacy-1",
					title: "Legacy blocker",
					status: "open",
					priority: 1,
					issue_type: "task",
					created_at: "2026-03-20T10:00:00.000+01:00",
					updated_at: "2026-03-20T10:00:00.000+01:00",
				}),
				JSON.stringify({
					id: "tau-legacy-2",
					title: "Legacy blocked",
					status: "open",
					priority: 2,
					issue_type: "task",
					created_at: "2026-03-20T10:01:00.000Z",
					updated_at: "2026-03-20T10:01:00.000Z",
					dependencies: [
						{
							issue_id: "tau-legacy-2",
							depends_on_id: "tau-legacy-1",
							type: "blocks",
							created_at: "2026-03-20T10:01:00.000Z",
						},
					],
					custom_field: { keep: true },
				}),
			].join("\n") + "\n",
			"utf8",
		);

		const imported = await importBeadsIfNeeded(workspaceRoot);
		expect(imported.map((issue) => issue.id).sort()).toEqual(["tau-legacy-1", "tau-legacy-2"]);
		expect(imported.find((issue) => issue.id === "tau-legacy-2")?.dependencies?.[0]?.depends_on_id).toBe("tau-legacy-1");
		expect(imported.find((issue) => issue.id === "tau-legacy-2")?.["custom_field"]).toEqual({ keep: true });

		const events = await readBacklogEventsFromWorkspace(workspaceRoot);
		expect(events).toHaveLength(2);
		expect(events.every((event) => event.kind === "issue.imported")).toBe(true);
		expect(events.find((event) => event.issue_id === "tau-legacy-1")?.recorded_at).toBe(
			"2026-03-20T09:00:00.000Z",
		);
	});

	it("imports from .beads/beads.db when jsonl is absent and rebuilds cache after appended events", async () => {
		const workspaceRoot = await makeWorkspace();
		const beadsDir = path.join(workspaceRoot, ".beads");
		await fs.mkdir(beadsDir, { recursive: true });

		const dbPath = path.join(beadsDir, "beads.db");
		const db = new DatabaseSync(dbPath);
		try {
			db.exec(`
				CREATE TABLE issues (
					id TEXT NOT NULL,
					title TEXT NOT NULL,
					description TEXT,
					status TEXT,
					priority INTEGER,
					issue_type TEXT,
					created_at TEXT,
					updated_at TEXT,
					deleted_at TEXT
				);
				CREATE TABLE dependencies (
					issue_id TEXT NOT NULL,
					depends_on_id TEXT NOT NULL,
					type TEXT NOT NULL,
					created_at TEXT NOT NULL,
					created_by TEXT
				);
				CREATE TABLE comments (
					id INTEGER PRIMARY KEY,
					issue_id TEXT NOT NULL,
					author TEXT NOT NULL,
					text TEXT NOT NULL,
					created_at TEXT NOT NULL
				);
			`);
			db.prepare(
				`INSERT INTO issues (id, title, description, status, priority, issue_type, created_at, updated_at, deleted_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
			).run(
				"tau-db-1",
				"Loaded from db",
				"db fallback",
				"open",
				1,
				"task",
				"2026-03-21T00:00:00.000Z",
				"2026-03-21T00:00:00.000Z",
			);
			db.prepare(
				`INSERT INTO comments (id, issue_id, author, text, created_at) VALUES (?, ?, ?, ?, ?)`,
			).run(1, "tau-db-1", "alice", "hello", "2026-03-21T00:00:00.000Z");
		} finally {
			db.close();
		}

		const imported = await importBeadsIfNeeded(workspaceRoot);
		expect(imported).toHaveLength(1);
		expect(imported[0]?.id).toBe("tau-db-1");
		expect(imported[0]?.comments?.[0]?.text).toBe("hello");

		await addIssueComment(workspaceRoot, {
			issueId: "tau-db-1",
			actor: "alice",
			text: "after import",
			recorded_at: "2026-03-21T00:01:00.000Z",
		});

		const cached = await readMaterializedIssuesCache(workspaceRoot);
		expect(cached[0]?.comments?.map((comment) => comment.text)).toEqual(["hello", "after import"]);
	});

	it("removes dependencies via a new immutable event", async () => {
		const workspaceRoot = await makeWorkspace();
		await createIssue(workspaceRoot, { title: "A", actor: "alice", id: "tau-a", recorded_at: "2026-03-29T12:00:00.000Z" });
		await createIssue(workspaceRoot, { title: "B", actor: "alice", id: "tau-b", recorded_at: "2026-03-29T12:00:01.000Z" });
		await addIssueDependency(workspaceRoot, {
			issueId: "tau-a",
			actor: "alice",
			dependsOnId: "tau-b",
			type: "blocks",
			recorded_at: "2026-03-29T12:00:02.000Z",
		});
		const updated = await removeIssueDependency(workspaceRoot, {
			issueId: "tau-a",
			actor: "alice",
			dependsOnId: "tau-b",
			type: "blocks",
			recorded_at: "2026-03-29T12:00:03.000Z",
		});

		expect(updated.dependencies ?? []).toEqual([]);
		expect((await readBacklogEventsFromWorkspace(workspaceRoot)).length).toBe(4);
	});

	it("serializes concurrent dependency appends so incompatible cycles cannot both commit", async () => {
		const workspaceRoot = await makeWorkspace();
		await createIssue(workspaceRoot, { title: "A", actor: "alice", id: "tau-a", recorded_at: "2026-03-29T12:00:00.000Z" });
		await createIssue(workspaceRoot, { title: "B", actor: "alice", id: "tau-b", recorded_at: "2026-03-29T12:00:01.000Z" });

		let acquiredCount = 0;
		let releaseFirstLock: (() => void) | undefined;
		const firstLockAcquired = new Promise<void>((resolve) => {
			setBacklogLockTestHooksForTesting({
				afterAcquire: async () => {
					acquiredCount += 1;
					if (acquiredCount !== 1) {
						return;
					}
					resolve();
					await new Promise<void>((innerResolve) => {
						releaseFirstLock = innerResolve;
					});
				},
			});
		});

		const first = addIssueDependency(workspaceRoot, {
			issueId: "tau-a",
			actor: "alice",
			dependsOnId: "tau-b",
			type: "blocks",
			recorded_at: "2026-03-29T12:00:02.000Z",
		});
		await firstLockAcquired;

		let secondSettled = false;
		const second = addIssueDependency(workspaceRoot, {
			issueId: "tau-b",
			actor: "alice",
			dependsOnId: "tau-a",
			type: "blocks",
			recorded_at: "2026-03-29T12:00:03.000Z",
		}).finally(() => {
			secondSettled = true;
		});

		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(acquiredCount).toBe(1);
		expect(secondSettled).toBe(false);

		releaseFirstLock?.();

		await expect(first).resolves.toMatchObject({ id: "tau-a" });
		await expect(second).rejects.toThrow();

		const events = await readBacklogEventsFromWorkspace(workspaceRoot);
		expect(events).toHaveLength(3);
		expect(events.filter((event) => event.kind === "issue.updated")).toHaveLength(1);

		const cached = await readMaterializedIssuesCache(workspaceRoot);
		expect(cached.find((issue) => issue.id === "tau-a")?.dependencies?.[0]?.depends_on_id).toBe("tau-b");
		expect(cached.find((issue) => issue.id === "tau-b")?.dependencies ?? []).toEqual([]);
	});
});
