import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import path from "node:path";

import { Schema } from "effect";

import {
	BacklogEventSchema,
	replayBacklogEvents,
	resolveBacklogPaths,
	sortBacklogEvents,
	type BacklogEvent,
} from "./contract.js";
import { assertNoDependencyCycles } from "./graph.js";
import { decodeIssue, encodeIssue, type Issue } from "./schema.js";
import { importBeadsIfNeededUnlocked } from "./storage.js";

export class BacklogMaterializationError extends Error {
	constructor(message: string, options?: { readonly cause?: unknown }) {
		super(message, options);
		this.name = "BacklogMaterializationError";
	}
}

type BacklogLockMetadata = {
	readonly pid: number;
	readonly token: string;
};

type BacklogLockTestHooks = {
	readonly afterAcquire?: (workspaceRoot: string) => Promise<void>;
	readonly maxAttempts?: number;
	readonly retryDelayMs?: number;
};

type BacklogLockMatch =
	| {
		readonly type: "token";
		readonly token: string;
	  }
	| {
		readonly type: "raw";
		readonly raw: string;
	  };

const decodeBacklogEvent = Schema.decodeUnknownSync(BacklogEventSchema);

const BACKLOG_LOCK_STALE_MS = 10_000;
const BACKLOG_LOCK_MAX_ATTEMPTS = 50;
const BACKLOG_LOCK_RETRY_MS = 100;

let backlogLockTestHooks: BacklogLockTestHooks | null = null;

function backlogLockPath(workspaceRoot: string): string {
	return path.join(resolveBacklogPaths(workspaceRoot).materializedCacheDir, ".lock");
}

function isNodeError(err: unknown, code: string): boolean {
	return typeof err === "object" && err !== null && "code" in err && err.code === code;
}

function parseLockMetadata(raw: string): BacklogLockMetadata | null {
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"pid" in parsed &&
			"token" in parsed &&
			typeof parsed.pid === "number" &&
			typeof parsed.token === "string"
		) {
			return { pid: parsed.pid, token: parsed.token };
		}
		return null;
	} catch {
		return null;
	}
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !isNodeError(error, "ESRCH");
	}
}

async function inspectBacklogLock(
	lockPath: string,
): Promise<{ readonly exists: boolean; readonly reclaimable: boolean; readonly match: BacklogLockMatch | null }> {
	try {
		const stats = await fs.stat(lockPath);
		const stale = Date.now() - stats.mtimeMs > BACKLOG_LOCK_STALE_MS;
		const raw = await fs.readFile(lockPath, "utf8");
		const metadata = parseLockMetadata(raw);
		if (!metadata) {
			return {
				exists: true,
				reclaimable: stale,
				match: { type: "raw", raw },
			};
		}
		return {
			exists: true,
			reclaimable: !processExists(metadata.pid),
			match: { type: "token", token: metadata.token },
		};
	} catch (error) {
		if (isNodeError(error, "ENOENT")) {
			return {
				exists: false,
				reclaimable: false,
				match: null,
			};
		}
		return {
			exists: false,
			reclaimable: false,
			match: null,
		};
	}
}

async function lockFileMatches(lockPath: string, expected: BacklogLockMatch): Promise<boolean> {
	try {
		const raw = await fs.readFile(lockPath, "utf8");
		if (expected.type === "raw") {
			return raw === expected.raw;
		}
		const metadata = parseLockMetadata(raw);
		return metadata?.token === expected.token;
	} catch (error) {
		if (isNodeError(error, "ENOENT")) {
			return false;
		}
		throw error;
	}
}

async function removeLockIfStillMatches(lockPath: string, expected: BacklogLockMatch): Promise<boolean> {
	if (!(await lockFileMatches(lockPath, expected))) {
		return false;
	}
	try {
		await fs.unlink(lockPath);
		return true;
	} catch (error) {
		if (isNodeError(error, "ENOENT")) {
			return false;
		}
		throw error;
	}
}

async function reclaimLockIfStillMatches(lockPath: string, expected: BacklogLockMatch): Promise<boolean> {
	const claimPath = `${lockPath}.claim-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	let result = false;
	let primaryError: unknown;
	let linked = false;
	try {
		await fs.link(lockPath, claimPath);
		linked = true;
	} catch (error) {
		if (isNodeError(error, "ENOENT")) {
			return false;
		}
		throw error;
	}

	try {
		if (!(await lockFileMatches(claimPath, expected))) {
			result = false;
		} else {
			let lockStats: fsSync.Stats | undefined;
			let claimStats: fsSync.Stats | undefined;
			try {
				lockStats = await fs.stat(lockPath);
				claimStats = await fs.stat(claimPath);
			} catch (error) {
				if (isNodeError(error, "ENOENT")) {
					result = false;
				} else {
					throw error;
				}
			}

			if (lockStats !== undefined && claimStats !== undefined) {
				if (lockStats.dev !== claimStats.dev || lockStats.ino !== claimStats.ino) {
					result = false;
				} else {
					try {
						await fs.unlink(lockPath);
						result = true;
					} catch (error) {
						if (isNodeError(error, "ENOENT")) {
							result = false;
						} else {
							throw error;
						}
					}
				}
			}
		}
	} catch (error) {
		primaryError = error;
	}

	let cleanupError: unknown;
	if (linked) {
		try {
			await fs.unlink(claimPath);
		} catch (error) {
			if (!isNodeError(error, "ENOENT")) {
				cleanupError = error;
			}
		}
	}

	if (primaryError !== undefined) {
		throw primaryError;
	}
	if (cleanupError !== undefined) {
		throw cleanupError;
	}
	return result;
}

export function setBacklogLockTestHooksForTesting(hooks: BacklogLockTestHooks | null): void {
	backlogLockTestHooks = hooks;
}

export async function withBacklogWriteLock<T>(workspaceRoot: string, fn: () => Promise<T>): Promise<T> {
	const paths = resolveBacklogPaths(workspaceRoot);
	await fs.mkdir(paths.materializedCacheDir, { recursive: true });
	const lockPath = backlogLockPath(workspaceRoot);
	const maxAttempts = backlogLockTestHooks?.maxAttempts ?? BACKLOG_LOCK_MAX_ATTEMPTS;
	const retryDelayMs = backlogLockTestHooks?.retryDelayMs ?? BACKLOG_LOCK_RETRY_MS;
	let fileHandle: fs.FileHandle | undefined;
	let token: string | undefined;

	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		try {
			fileHandle = await fs.open(
				lockPath,
				fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL,
				0o644,
			);
			token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
			await fileHandle.writeFile(JSON.stringify({ pid: process.pid, token }), "utf8");
			break;
		} catch (error) {
			if (!isNodeError(error, "EEXIST")) {
				throw error;
			}

			const inspection = await inspectBacklogLock(lockPath);
			if (inspection.reclaimable && inspection.match) {
				await reclaimLockIfStillMatches(lockPath, inspection.match);
				continue;
			}

			if (attempt === maxAttempts - 1) {
				throw error;
			}

			await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
		}
	}

	if (!fileHandle) {
		throw new Error(`Failed to acquire backlog lock at ${lockPath}`);
	}

	try {
		const afterAcquire = backlogLockTestHooks?.afterAcquire;
		if (afterAcquire) {
			await afterAcquire(workspaceRoot);
		}
		return await fn();
	} finally {
		await fileHandle.close();
		try {
			if (token) {
				await removeLockIfStillMatches(lockPath, { type: "token", token });
			}
		} catch {
		}
	}
}

async function listFilesRecursive(rootDir: string): Promise<ReadonlyArray<string>> {
	const entries = await fs.readdir(rootDir, { withFileTypes: true });
	const files: string[] = [];

	for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
		const absolutePath = path.join(rootDir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listFilesRecursive(absolutePath)));
			continue;
		}
		if (entry.isFile()) {
			files.push(absolutePath);
		}
	}

	return files;
}

export async function readBacklogEventsFromWorkspaceUnlocked(
	workspaceRoot: string,
): Promise<ReadonlyArray<BacklogEvent>> {
	await importBeadsIfNeededUnlocked(workspaceRoot);
	const paths = resolveBacklogPaths(workspaceRoot);

	let filePaths: ReadonlyArray<string>;
	try {
		filePaths = await listFilesRecursive(paths.canonicalEventsDir);
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
		if (code === "ENOENT") {
			return [];
		}
		throw new BacklogMaterializationError(
			`Failed to list backlog events under ${paths.canonicalEventsDir}`,
			{ cause: error },
		);
	}

	const events: BacklogEvent[] = [];
	for (const filePath of filePaths) {
		const raw = await fs.readFile(filePath, "utf8");
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw) as unknown;
		} catch (error) {
			throw new BacklogMaterializationError(`Invalid JSON in backlog event file ${filePath}`, {
				cause: error,
			});
		}

		try {
			events.push(decodeBacklogEvent(parsed));
		} catch (error) {
			throw new BacklogMaterializationError(`Invalid backlog event in ${filePath}`, { cause: error });
		}
	}

	return sortBacklogEvents(events);
}

export async function readBacklogEventsFromWorkspace(
	workspaceRoot: string,
): Promise<ReadonlyArray<BacklogEvent>> {
	return withBacklogWriteLock(workspaceRoot, () => readBacklogEventsFromWorkspaceUnlocked(workspaceRoot));
}

export function materializeBacklogIssues(events: ReadonlyArray<BacklogEvent>): ReadonlyArray<Issue> {
	const replayed = replayBacklogEvents(events);
	const issues = Array.from(replayed.values(), (issue) => {
		try {
			return decodeIssue(issue.fields);
		} catch (error) {
			throw new BacklogMaterializationError(
				`Invalid materialized issue state for ${issue.issue_id}`,
				{ cause: error },
			);
		}
	});

	assertNoDependencyCycles(issues);
	return issues;
}

export function assertBacklogEventCanBeApplied(
	existingEvents: ReadonlyArray<BacklogEvent>,
	candidateEvent: BacklogEvent,
): void {
	materializeBacklogIssues([...existingEvents, candidateEvent]);
}

export function serializeMaterializedIssues(issues: ReadonlyArray<Issue>): string {
	if (issues.length === 0) {
		return "";
	}
	return `${issues.map((issue) => JSON.stringify(encodeIssue(issue))).join("\n")}\n`;
}

export function parseMaterializedIssues(raw: string): ReadonlyArray<Issue> {
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		return [];
	}

	return trimmed.split(/\n+/u).map((line, index) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line) as unknown;
		} catch (error) {
			throw new BacklogMaterializationError(`Invalid JSONL backlog cache entry at line ${index + 1}`, {
				cause: error,
			});
		}

		try {
			return decodeIssue(parsed);
		} catch (error) {
			throw new BacklogMaterializationError(
				`Invalid backlog cache issue at line ${index + 1}`,
				{ cause: error },
			);
		}
	});
}

export async function writeMaterializedIssuesCache(
	workspaceRoot: string,
	issues: ReadonlyArray<Issue>,
): Promise<string> {
	const paths = resolveBacklogPaths(workspaceRoot);
	await fs.mkdir(paths.materializedCacheDir, { recursive: true });

	const tempPath = `${paths.materializedIssuesPath}.tmp-${process.pid}-${Date.now()}`;
	await fs.writeFile(tempPath, serializeMaterializedIssues(issues), "utf8");
	await fs.rename(tempPath, paths.materializedIssuesPath);
	return paths.materializedIssuesPath;
}

export async function readMaterializedIssuesCache(
	workspaceRoot: string,
): Promise<ReadonlyArray<Issue>> {
	const paths = resolveBacklogPaths(workspaceRoot);
	try {
		return parseMaterializedIssues(await fs.readFile(paths.materializedIssuesPath, "utf8"));
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
		if (code === "ENOENT") {
			return rebuildBacklogCache(workspaceRoot);
		}
		throw error;
	}
}

export async function rebuildBacklogCacheUnlocked(
	workspaceRoot: string,
): Promise<ReadonlyArray<Issue>> {
	const events = await readBacklogEventsFromWorkspaceUnlocked(workspaceRoot);
	const issues = materializeBacklogIssues(events);
	await writeMaterializedIssuesCache(workspaceRoot, issues);
	return issues;
}

export async function rebuildBacklogCache(
	workspaceRoot: string,
): Promise<ReadonlyArray<Issue>> {
	return withBacklogWriteLock(workspaceRoot, () => rebuildBacklogCacheUnlocked(workspaceRoot));
}
