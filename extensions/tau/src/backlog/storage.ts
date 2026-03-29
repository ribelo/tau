import * as fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Schema } from "effect";

import {
	BacklogIssueImportedEventSchema,
	resolveBacklogPaths,
	type BacklogEvent,
} from "./contract.js";
import {
	decodeIssue,
	encodeIssue,
	type Comment,
	type Dependency,
	type Issue,
} from "./schema.js";

export class BacklogMutationError extends Error {
	constructor(message: string, options?: { readonly cause?: unknown }) {
		super(message, options);
		this.name = "BacklogMutationError";
	}
}

type SqliteRow = Record<string, unknown>;

const decodeImportedEvent = Schema.decodeUnknownSync(BacklogIssueImportedEventSchema);

function nowIso(): string {
	return new Date().toISOString();
}

function canonicalizeLegacyTimestamp(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}

	const timestamp = Date.parse(value);
	if (Number.isNaN(timestamp)) {
		return undefined;
	}

	return new Date(timestamp).toISOString();
}

function datePathFromRecordedAt(recordedAt: string): string {
	return recordedAt.slice(0, 10).split("-").join(path.sep);
}

function safeFileToken(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/gu, "_");
}

function eventFilePath(workspaceRoot: string, event: Pick<BacklogEvent, "recorded_at" | "event_id">): string {
	const paths = resolveBacklogPaths(workspaceRoot);
	return path.join(
		paths.canonicalEventsDir,
		datePathFromRecordedAt(event.recorded_at),
		`${safeFileToken(event.event_id)}.json`,
	);
}

function tempEventFilePath(workspaceRoot: string, eventId: string): string {
	const paths = resolveBacklogPaths(workspaceRoot);
	return path.join(paths.materializedCacheDir, `.event-tmp-${safeFileToken(eventId)}-${process.pid}-${Date.now()}`);
}

export async function writeEventFile(workspaceRoot: string, event: BacklogEvent): Promise<string> {
	const finalPath = eventFilePath(workspaceRoot, event);
	const tempPath = tempEventFilePath(workspaceRoot, event.event_id);
	const paths = resolveBacklogPaths(workspaceRoot);

	await fs.mkdir(path.dirname(finalPath), { recursive: true });
	await fs.mkdir(paths.materializedCacheDir, { recursive: true });
	await fs.writeFile(tempPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "wx" });
	try {
		await fs.rename(tempPath, finalPath);
	} catch (error) {
		await fs.rm(tempPath, { force: true });
		throw error;
	}
	return finalPath;
}

function issueTimestamp(issue: Issue): number {
	const updated = issue.updated_at ? Date.parse(issue.updated_at) : Number.NaN;
	if (!Number.isNaN(updated)) {
		return updated;
	}
	const created = issue.created_at ? Date.parse(issue.created_at) : Number.NaN;
	if (!Number.isNaN(created)) {
		return created;
	}
	return 0;
}

function mergeImportedIssues(
	jsonlIssues: ReadonlyArray<Issue>,
	dbIssues: ReadonlyArray<Issue>,
): ReadonlyArray<Issue> {
	const merged = new Map<string, Issue>();

	for (const issue of jsonlIssues) {
		merged.set(issue.id, issue);
	}

	for (const issue of dbIssues) {
		const existing = merged.get(issue.id);
		if (!existing || issueTimestamp(issue) > issueTimestamp(existing)) {
			merged.set(issue.id, issue);
		}
	}

	return [...merged.values()];
}

async function readBeadsIssuesJsonl(beadsIssuesPath: string): Promise<ReadonlyArray<Issue>> {
	let raw: string;
	try {
		raw = await fs.readFile(beadsIssuesPath, "utf8");
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
		if (code === "ENOENT") {
			return [];
		}
		throw error;
	}

	const lines = raw
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	return lines.map((line, index) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line) as unknown;
		} catch (error) {
			throw new BacklogMutationError(
				`Invalid JSON in .beads/issues.jsonl at line ${index + 1}`,
				{ cause: error },
			);
		}

		try {
			return decodeIssue(parsed);
		} catch (error) {
			throw new BacklogMutationError(
				`Invalid issue in .beads/issues.jsonl at line ${index + 1}`,
				{ cause: error },
			);
		}
	});
}

function getRecord(value: unknown): SqliteRow | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as SqliteRow;
}

function getString(row: SqliteRow, key: string): string | undefined {
	const value = row[key];
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function getNumber(row: SqliteRow, key: string): number | undefined {
	const value = row[key];
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "bigint") {
		return Number(value);
	}
	if (typeof value === "string") {
		const parsed = Number(value.trim());
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function getBoolean(row: SqliteRow, key: string): boolean | undefined {
	const value = row[key];
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		if (value === 0) return false;
		if (value === 1) return true;
	}
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true" || normalized === "1") return true;
		if (normalized === "false" || normalized === "0") return false;
	}
	return undefined;
}

function getStringArray(row: SqliteRow, key: string): ReadonlyArray<string> | undefined {
	const value = row[key];
	if (Array.isArray(value)) {
		const strings = value.filter((item): item is string => typeof item === "string");
		return strings.length > 0 ? strings : undefined;
	}
	if (typeof value !== "string") {
		return undefined;
	}
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) {
			return undefined;
		}
		const strings = parsed.filter((item): item is string => typeof item === "string");
		return strings.length > 0 ? strings : undefined;
	} catch {
		return undefined;
	}
}

function tableExists(database: DatabaseSync, table: string): boolean {
	const row = database
		.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
		.get(table);
	return row !== null && row !== undefined;
}

function readTableRows(database: DatabaseSync, table: "issues" | "dependencies" | "comments" | "labels"): ReadonlyArray<SqliteRow> {
	if (!tableExists(database, table)) {
		return [];
	}
	return database
		.prepare(`SELECT * FROM ${table}`)
		.all()
		.map(getRecord)
		.filter((row): row is SqliteRow => row !== null);
}

function parseDependencyRow(row: SqliteRow): Dependency | undefined {
	const issueId = getString(row, "issue_id");
	const dependsOnId = getString(row, "depends_on_id");
	const type = getString(row, "type");
	const createdAt = getString(row, "created_at");
	if (!issueId || !dependsOnId || !type || !createdAt) {
		return undefined;
	}

	return {
		issue_id: issueId,
		depends_on_id: dependsOnId,
		type,
		created_at: createdAt,
		...(getString(row, "created_by") ? { created_by: getString(row, "created_by") } : {}),
		...(getString(row, "thread_id") ? { thread_id: getString(row, "thread_id") } : {}),
		...("metadata" in row && row["metadata"] !== undefined ? { metadata: row["metadata"] } : {}),
	} satisfies Dependency;
}

function parseCommentRow(row: SqliteRow): Comment | undefined {
	const id = getNumber(row, "id");
	const issueId = getString(row, "issue_id");
	const author = getString(row, "author");
	const text = getString(row, "text");
	const createdAt = getString(row, "created_at");
	if (id === undefined || !issueId || !author || !text || !createdAt) {
		return undefined;
	}
	return { id, issue_id: issueId, author, text, created_at: createdAt };
}

function mapDbIssueRow(
	row: SqliteRow,
	depsByIssue: ReadonlyMap<string, ReadonlyArray<Dependency>>,
	commentsByIssue: ReadonlyMap<string, ReadonlyArray<Comment>>,
	labelsByIssue: ReadonlyMap<string, ReadonlyArray<string>>,
): Issue | undefined {
	const id = getString(row, "id");
	const title = getString(row, "title");
	if (!id || !title) {
		throw new BacklogMutationError("Invalid SQLite issue row: missing or empty required field 'id' or 'title'");
	}

	const candidate: Record<string, unknown> = { id, title };
	const setIfDefined = (key: string, value: unknown): void => {
		if (value !== undefined) {
			candidate[key] = value;
		}
	};

	setIfDefined("description", getString(row, "description"));
	setIfDefined("design", getString(row, "design"));
	setIfDefined("acceptance_criteria", getString(row, "acceptance_criteria"));
	setIfDefined("notes", getString(row, "notes"));
	setIfDefined("status", getString(row, "status"));
	setIfDefined("priority", getNumber(row, "priority"));
	setIfDefined("issue_type", getString(row, "issue_type"));
	setIfDefined("assignee", getString(row, "assignee"));
	setIfDefined("owner", getString(row, "owner"));
	setIfDefined("estimated_minutes", getNumber(row, "estimated_minutes"));
	setIfDefined("created_at", getString(row, "created_at"));
	setIfDefined("created_by", getString(row, "created_by"));
	setIfDefined("updated_at", getString(row, "updated_at"));
	setIfDefined("closed_at", getString(row, "closed_at"));
	setIfDefined("close_reason", getString(row, "close_reason"));
	setIfDefined("closed_by_session", getString(row, "closed_by_session"));
	setIfDefined("due_at", getString(row, "due_at"));
	setIfDefined("defer_until", getString(row, "defer_until"));
	setIfDefined("external_ref", getString(row, "external_ref"));
	setIfDefined("source_system", getString(row, "source_system"));
	setIfDefined("compaction_level", getNumber(row, "compaction_level"));
	setIfDefined("compacted_at", getString(row, "compacted_at"));
	setIfDefined("compacted_at_commit", getString(row, "compacted_at_commit"));
	setIfDefined("original_size", getNumber(row, "original_size"));
	setIfDefined("deleted_at", getString(row, "deleted_at"));
	if (candidate["deleted_at"] !== undefined) {
		return undefined;
	}
	setIfDefined("deleted_by", getString(row, "deleted_by"));
	setIfDefined("delete_reason", getString(row, "delete_reason"));
	setIfDefined("original_type", getString(row, "original_type"));
	setIfDefined("sender", getString(row, "sender"));
	setIfDefined("ephemeral", getBoolean(row, "ephemeral"));
	setIfDefined("pinned", getBoolean(row, "pinned"));
	setIfDefined("is_template", getBoolean(row, "is_template"));
	setIfDefined("quality_score", getNumber(row, "quality_score"));
	setIfDefined("crystallizes", getBoolean(row, "crystallizes"));
	setIfDefined("await_type", getString(row, "await_type"));
	setIfDefined("await_id", getString(row, "await_id"));
	setIfDefined("timeout", getNumber(row, "timeout_ns"));
	setIfDefined("waiters", getStringArray(row, "waiters"));
	setIfDefined("hook_bead", getString(row, "hook_bead"));
	setIfDefined("role_bead", getString(row, "role_bead"));
	setIfDefined("agent_state", getString(row, "agent_state"));
	setIfDefined("last_activity", getString(row, "last_activity"));
	setIfDefined("role_type", getString(row, "role_type"));
	setIfDefined("rig", getString(row, "rig"));
	setIfDefined("mol_type", getString(row, "mol_type"));
	setIfDefined("work_type", getString(row, "work_type"));
	setIfDefined("event_kind", getString(row, "event_kind"));
	setIfDefined("actor", getString(row, "actor"));
	setIfDefined("target", getString(row, "target"));
	setIfDefined("payload", getString(row, "payload"));

	const dependencies = depsByIssue.get(id);
	const comments = commentsByIssue.get(id);
	const labels = labelsByIssue.get(id);
	if (dependencies && dependencies.length > 0) {
		candidate["dependencies"] = dependencies;
	}
	if (comments && comments.length > 0) {
		candidate["comments"] = comments;
	}
	if (labels && labels.length > 0) {
		candidate["labels"] = labels;
	}

	return decodeIssue(candidate);
}

async function readBeadsIssuesDb(dbPath: string): Promise<ReadonlyArray<Issue>> {
	try {
		await fs.access(dbPath);
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
		if (code === "ENOENT") {
			return [];
		}
		throw error;
	}

	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		const dependencyRows = readTableRows(db, "dependencies");
		const depsByIssue = new Map<string, Dependency[]>();
		for (const row of dependencyRows) {
			const dependency = parseDependencyRow(row);
			if (!dependency) continue;
			const existing = depsByIssue.get(dependency.issue_id);
			if (existing) {
				existing.push(dependency);
			} else {
				depsByIssue.set(dependency.issue_id, [dependency]);
			}
		}

		const commentRows = readTableRows(db, "comments");
		const commentsByIssue = new Map<string, Comment[]>();
		for (const row of commentRows) {
			const comment = parseCommentRow(row);
			if (!comment) continue;
			const existing = commentsByIssue.get(comment.issue_id);
			if (existing) {
				existing.push(comment);
			} else {
				commentsByIssue.set(comment.issue_id, [comment]);
			}
		}

		const labelRows = readTableRows(db, "labels");
		const labelsByIssue = new Map<string, string[]>();
		for (const row of labelRows) {
			const issueId = getString(row, "issue_id");
			const label = getString(row, "label");
			if (!issueId || !label) continue;
			const existing = labelsByIssue.get(issueId);
			if (existing) {
				existing.push(label);
			} else {
				labelsByIssue.set(issueId, [label]);
			}
		}

		const issues: Issue[] = [];
		for (const row of readTableRows(db, "issues")) {
			const issue = mapDbIssueRow(row, depsByIssue, commentsByIssue, labelsByIssue);
			if (issue) {
				issues.push(issue);
			}
		}
		return issues;
	} finally {
		db.close();
	}
}

function importedEventForIssue(issue: Issue): BacklogEvent {
	const recordedAt =
		canonicalizeLegacyTimestamp(issue.updated_at) ??
		canonicalizeLegacyTimestamp(issue.created_at) ??
		nowIso();
	return decodeImportedEvent({
		schema_version: 1,
		event_id: `import-${issue.id}`,
		issue_id: issue.id,
		recorded_at: recordedAt,
		actor: issue.created_by ?? issue.owner ?? "beads-import",
		kind: "issue.imported",
		source: {
			system: "beads",
			issue_id: issue.id,
		},
		fields: encodeIssue(issue),
	});
}

async function listEventFiles(workspaceRoot: string): Promise<ReadonlyArray<string>> {
	const paths = resolveBacklogPaths(workspaceRoot);
	const walk = async (dirPath: string): Promise<ReadonlyArray<string>> => {
		const entries = await fs.readdir(dirPath, { withFileTypes: true });
		const files: string[] = [];
		for (const entry of entries) {
			const absolutePath = path.join(dirPath, entry.name);
			if (entry.isDirectory()) {
				files.push(...(await walk(absolutePath)));
				continue;
			}
			if (entry.isFile()) {
				files.push(absolutePath);
			}
		}
		return files;
	};
	try {
		return await walk(paths.canonicalEventsDir);
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
		if (code === "ENOENT") {
			return [];
		}
		throw error;
	}
}

async function hasCanonicalEvents(workspaceRoot: string): Promise<boolean> {
	const files = await listEventFiles(workspaceRoot);
	return files.length > 0;
}

export async function importBeadsIfNeededUnlocked(workspaceRoot: string): Promise<ReadonlyArray<Issue>> {
	if (await hasCanonicalEvents(workspaceRoot)) {
		return [];
	}

	const beadsDir = path.join(workspaceRoot, ".beads");
	const jsonlIssues = await readBeadsIssuesJsonl(path.join(beadsDir, "issues.jsonl"));
	const dbIssues = await readBeadsIssuesDb(path.join(beadsDir, "beads.db"));
	const issuesToImport = mergeImportedIssues(jsonlIssues, dbIssues);

	if (issuesToImport.length === 0) {
		return [];
	}

	for (const issue of issuesToImport) {
		await writeEventFile(workspaceRoot, importedEventForIssue(issue));
	}

	return issuesToImport;
}
