import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { BacklogEventSchema } from "../src/backlog/contract.js";
import { listDependencies, listDependents } from "../src/backlog/graph.js";
import {
	assertBacklogEventCanBeApplied,
	parseMaterializedIssues,
	rebuildBacklogCache,
	readBacklogEventsFromWorkspace,
	readMaterializedIssuesCache,
	serializeMaterializedIssues,
	type BacklogMaterializationError,
} from "../src/backlog/materialize.js";
import { filterIssues } from "../src/backlog/query.js";

const decodeBacklogEvent = Schema.decodeUnknownSync(BacklogEventSchema);

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tau-backlog-"));
	tempDirs.push(dir);
	return dir;
}

function makeCreatedEvent(issueId: string, title: string, extraFields: Record<string, unknown> = {}) {
	return decodeBacklogEvent({
		schema_version: 1,
		event_id: `evt-${issueId}-001`,
		issue_id: issueId,
		recorded_at: "2026-03-29T12:00:00.000Z",
		actor: "alice",
		kind: "issue.created",
		fields: {
			id: issueId,
			title,
			status: "open",
			priority: 2,
			issue_type: "task",
			created_at: "2026-03-29T12:00:00.000Z",
			updated_at: "2026-03-29T12:00:00.000Z",
			...extraFields,
		},
	});
}

describe("backlog materialization", () => {
	it("materializes workspace events into cache and preserves unknown fields", async () => {
		const workspaceRoot = await makeWorkspace();
		const eventsDir = path.join(workspaceRoot, ".pi", "backlog", "events", "2026", "03");
		await fs.mkdir(eventsDir, { recursive: true });

		const imported = decodeBacklogEvent({
			schema_version: 1,
			event_id: "evt-import-001",
			issue_id: "tau-legacy-7",
			recorded_at: "2026-03-29T12:00:00.000Z",
			actor: "importer",
			kind: "issue.imported",
			source: { system: "beads", issue_id: "tau-legacy-7" },
			fields: {
				id: "tau-legacy-7",
				title: "Imported",
				status: "open",
				priority: 2,
				issue_type: "task",
				created_at: "2026-03-29T12:00:00.000Z",
				updated_at: "2026-03-29T12:00:00.000Z",
				custom_payload: { nested: ["a", "b"] },
			},
		});

		await fs.writeFile(path.join(eventsDir, "0001.json"), JSON.stringify(imported), "utf8");

		const events = await readBacklogEventsFromWorkspace(workspaceRoot);
		expect(events).toHaveLength(1);

		const issues = await rebuildBacklogCache(workspaceRoot);
		expect(issues).toHaveLength(1);
		expect(issues[0]?.["custom_payload"]).toEqual({ nested: ["a", "b"] });

		const cached = await readMaterializedIssuesCache(workspaceRoot);
		expect(cached).toEqual(issues);
		expect(parseMaterializedIssues(serializeMaterializedIssues(issues))).toEqual(issues);
	});

	it("seeds backlog events from .beads on first cache read", async () => {
		const workspaceRoot = await makeWorkspace();
		const beadsDir = path.join(workspaceRoot, ".beads");
		await fs.mkdir(beadsDir, { recursive: true });
		await fs.writeFile(
			path.join(beadsDir, "issues.jsonl"),
			`${JSON.stringify({
				id: "tau-legacy-1",
				title: "Imported on cache read",
				status: "open",
				priority: 2,
				issue_type: "task",
				created_at: "2026-03-20T10:00:00.000Z",
				updated_at: "2026-03-20T10:00:00.000Z",
			})}\n`,
			"utf8",
		);

		const issues = await readMaterializedIssuesCache(workspaceRoot);
		expect(issues.map((issue) => issue.id)).toEqual(["tau-legacy-1"]);

		const events = await readBacklogEventsFromWorkspace(workspaceRoot);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("issue.imported");

		const cachedAgain = await readMaterializedIssuesCache(workspaceRoot);
		expect(cachedAgain).toEqual(issues);
	});

	it("supports ready, blocked, and dependency views from replayed state", async () => {
		const workspaceRoot = await makeWorkspace();
		const eventsDir = path.join(workspaceRoot, ".pi", "backlog", "events");
		await fs.mkdir(eventsDir, { recursive: true });

		const blocker = makeCreatedEvent("tau-1", "Blocker");
		const blocked = makeCreatedEvent("tau-2", "Blocked", {
			dependencies: [
				{
					issue_id: "tau-2",
					depends_on_id: "tau-1",
					type: "blocks",
					created_at: "2026-03-29T12:01:00.000Z",
				},
			],
		});
		const ready = makeCreatedEvent("tau-3", "Ready");

		await fs.writeFile(path.join(eventsDir, "1.json"), JSON.stringify(blocker), "utf8");
		await fs.writeFile(path.join(eventsDir, "2.json"), JSON.stringify(blocked), "utf8");
		await fs.writeFile(path.join(eventsDir, "3.json"), JSON.stringify(ready), "utf8");

		const issues = await rebuildBacklogCache(workspaceRoot);
		expect(filterIssues(issues, { ready: true }).map((issue) => issue.id)).toEqual(["tau-1", "tau-3"]);
		expect(filterIssues(issues, { blocked: true }).map((issue) => issue.id)).toEqual(["tau-2"]);
		expect(listDependencies("tau-2", issues).map((issue) => issue.id)).toEqual(["tau-1"]);
		expect(listDependents("tau-1", issues).map((issue) => issue.id)).toEqual(["tau-2"]);
	});

	it("replays branch-merged event files with deterministic field-level last-write-wins", async () => {
		const workspaceRoot = await makeWorkspace();
		const eventsDir = path.join(workspaceRoot, ".pi", "backlog", "events", "2026", "03", "29");
		await fs.mkdir(eventsDir, { recursive: true });

		const created = makeCreatedEvent("tau-merge-1", "Base title", {
			notes: "carry me",
			priority: 3,
		});
		const branchLater = decodeBacklogEvent({
			schema_version: 1,
			event_id: "evt-tau-merge-1-200",
			issue_id: "tau-merge-1",
			recorded_at: "2026-03-29T12:01:00.000Z",
			actor: "branch-b",
			kind: "issue.updated",
			set_fields: {
				status: "blocked",
				priority: 1,
				updated_at: "2026-03-29T12:01:00.000Z",
			},
			unset_fields: ["notes"],
		});
		const branchEarlier = decodeBacklogEvent({
			schema_version: 1,
			event_id: "evt-tau-merge-1-100",
			issue_id: "tau-merge-1",
			recorded_at: "2026-03-29T12:01:00.000Z",
			actor: "branch-a",
			kind: "issue.updated",
			set_fields: {
				title: "Merged title",
				status: "in_progress",
				notes: "branch note",
				updated_at: "2026-03-29T12:01:00.000Z",
			},
			unset_fields: [],
		});

		await fs.writeFile(path.join(eventsDir, "00-created.json"), JSON.stringify(created), "utf8");
		await fs.writeFile(path.join(eventsDir, "10-branch-b.json"), JSON.stringify(branchLater), "utf8");
		await fs.writeFile(path.join(eventsDir, "99-branch-a.json"), JSON.stringify(branchEarlier), "utf8");

		const replayOrder = await readBacklogEventsFromWorkspace(workspaceRoot);
		expect(replayOrder.map((event) => event.event_id)).toEqual([
			"evt-tau-merge-1-001",
			"evt-tau-merge-1-100",
			"evt-tau-merge-1-200",
		]);

		const issues = await rebuildBacklogCache(workspaceRoot);
		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatchObject({
			id: "tau-merge-1",
			title: "Merged title",
			status: "blocked",
			priority: 1,
		});
		expect(issues[0]?.notes).toBeUndefined();
	});

	it("rejects dependency cycles before invalid events are applied", () => {
		const existingEvents = [
			makeCreatedEvent("tau-a", "A", {
				dependencies: [
					{
						issue_id: "tau-a",
						depends_on_id: "tau-b",
						type: "blocks",
						created_at: "2026-03-29T12:01:00.000Z",
					},
				],
			}),
			makeCreatedEvent("tau-b", "B"),
		];

		const candidate = decodeBacklogEvent({
			schema_version: 1,
			event_id: "evt-tau-b-002",
			issue_id: "tau-b",
			recorded_at: "2026-03-29T12:02:00.000Z",
			actor: "alice",
			kind: "issue.updated",
			set_fields: {
				dependencies: [
					{
						issue_id: "tau-b",
						depends_on_id: "tau-a",
						type: "blocks",
						created_at: "2026-03-29T12:02:00.000Z",
					},
				],
				updated_at: "2026-03-29T12:02:00.000Z",
			},
			unset_fields: [],
		});

		expect(() => assertBacklogEventCanBeApplied(existingEvents, candidate)).toThrow();
	});
});
