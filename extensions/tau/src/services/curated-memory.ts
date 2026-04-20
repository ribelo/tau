import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DateTime, Effect, Layer, Ref, Semaphore, ServiceMap } from "effect";
import type { Scope } from "effect";
import { nanoid } from "nanoid";

import { PiAPI } from "../effect/pi.js";
import {
	type MemoryEntry,
	type MemoryEntryId,
	type MemoryEntriesSnapshot,
	type MemoryBucketEntriesSnapshot,
	type MemoryBucketSnapshot,
	type MemorySnapshot,
	type MemoryScope,
	type MemoryIndex,
	charCount,
	cloneMemoryEntry,
	createMemoryEntry,
	makeMemoryIndex,
	memorySummaryMatchesContent,
	migrateLegacyMarkdownToJsonl,
	normalizeMemoryContent,
	normalizeMemorySummary,
	parseMemoryEntries,
	parseMemoryEntriesWithMigration,
	renderMemoryIndexXml,
	serializeMemoryEntries,
} from "../memory/format.js";
import {
	MemoryDuplicateEntry,
	MemoryDuplicateSummary,
	MemoryEntryTooLarge,
	MemoryEmptyContent,
	MemoryEmptySummary,
	MemoryFileError,
	MemoryNoMatch,
	MemorySummaryMatchesContent,
	type MemoryMutationError,
} from "../memory/errors.js";
import { getProjectTauMemoryDir, getTauMemoryDir } from "../shared/discovery.js";

// Claude Code's MEMORY.md entrypoint is capped at ~25k bytes. Keep tau scope
// limits in the same order of magnitude so memory is durable without frequent
// pruning churn.
const PROJECT_SCOPE_CHAR_LIMIT = 25_000;
const GLOBAL_SCOPE_CHAR_LIMIT = 25_000;
const USER_SCOPE_CHAR_LIMIT = 25_000;
const LOCK_STALE_MS = 5_000;
const MEMORY_ID_SHORT_LENGTH = 12;

interface FrozenSnapshot {
	readonly renderedIndex: string;
	readonly index: MemoryIndex;
	readonly entriesSnapshot: MemoryEntriesSnapshot;
}

interface LockMetadata {
	readonly pid: number;
	readonly token: string;
}

export interface MutationResult {
	readonly changedScope: MemoryScope;
	readonly entry: MemoryEntry;
}

function scopeLimitForScope(scope: MemoryScope): number {
	switch (scope) {
		case "project":
			return PROJECT_SCOPE_CHAR_LIMIT;
		case "global":
			return GLOBAL_SCOPE_CHAR_LIMIT;
		case "user":
			return USER_SCOPE_CHAR_LIMIT;
	}
}

function fileNameForScope(scope: MemoryScope): string {
	switch (scope) {
		case "project":
			return "PROJECT.jsonl";
		case "global":
			return "MEMORY.jsonl";
		case "user":
			return "USER.jsonl";
	}
}

function legacyFileNameForScope(scope: MemoryScope): string {
	switch (scope) {
		case "project":
			return "PROJECT.md";
		case "global":
			return "MEMORY.md";
		case "user":
			return "USER.md";
	}
}

function normalizeEntryText(text: string): string {
	return normalizeMemoryContent(text);
}

function normalizeSummaryText(text: string): string {
	return normalizeMemorySummary(text);
}

interface MemoryDraft {
	readonly summary: string;
	readonly content: string;
}

function normalizeMemoryDraft(summary: string, content: string): MemoryDraft {
	return {
		summary: normalizeSummaryText(summary),
		content: normalizeEntryText(content),
	};
}

function directoryForScope(scope: MemoryScope, cwd: string): string {
	return scope === "project" ? getProjectTauMemoryDir(cwd) : getTauMemoryDir();
}

function scopePath(scope: MemoryScope, cwd: string): string {
	return path.join(directoryForScope(scope, cwd), fileNameForScope(scope));
}

function legacyScopePath(scope: MemoryScope, cwd: string): string {
	return path.join(directoryForScope(scope, cwd), legacyFileNameForScope(scope));
}

function lockFilePath(scope: MemoryScope, cwd: string): string {
	return path.join(directoryForScope(scope, cwd), ".lock");
}

async function ensureDir(dirPath: string): Promise<void> {
	await fs.mkdir(dirPath, { recursive: true });
}

function isNodeError(err: unknown, code: string): boolean {
	return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === code;
}

function parseLockMetadata(raw: string): LockMetadata | null {
	try {
		const parsed = JSON.parse(raw);
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
	} catch (err: unknown) {
		return !isNodeError(err, "ESRCH");
	}
}

async function shouldReclaimLock(lockPath: string): Promise<boolean> {
	try {
		const stats = await fs.stat(lockPath);
		const stale = Date.now() - stats.mtimeMs > LOCK_STALE_MS;
		const raw = await fs.readFile(lockPath, "utf8");
		const metadata = parseLockMetadata(raw);
		if (!metadata) {
			return stale;
		}
		return stale || !processExists(metadata.pid);
	} catch (err: unknown) {
		if (isNodeError(err, "ENOENT")) {
			return false;
		}
		return true;
	}
}

function entryContents(entries: readonly MemoryEntry[]): string[] {
	return entries.map((entry) => entry.content);
}

interface ReadJsonlScopeResult {
	readonly entries: MemoryEntry[];
	readonly migrated: boolean;
}

function migrateLegacyLongIds(entries: readonly MemoryEntry[]): ReadJsonlScopeResult {
	const usedIds = new Set<string>();
	let migrated = false;

	const migratedEntries = entries.map((entry) => {
		const currentId = entry.id;
		const shouldMigrate = currentId.length > MEMORY_ID_SHORT_LENGTH || usedIds.has(currentId);

		if (!shouldMigrate) {
			usedIds.add(currentId);
			return entry;
		}

		migrated = true;
		let nextId = nanoid(MEMORY_ID_SHORT_LENGTH);
		while (usedIds.has(nextId)) {
			nextId = nanoid(MEMORY_ID_SHORT_LENGTH);
		}
		usedIds.add(nextId);

		return cloneMemoryEntry(entry, { id: nextId });
	});

	return {
		entries: migratedEntries,
		migrated,
	};
}

async function readJsonlScope(scope: MemoryScope, cwd: string): Promise<ReadJsonlScopeResult> {
	const raw = await fs.readFile(scopePath(scope, cwd), "utf-8");
	const parsed = parseMemoryEntriesWithMigration(raw, { scope });
	const ids = migrateLegacyLongIds(parsed.entries);
	return {
		entries: ids.entries,
		migrated: parsed.migrated || ids.migrated,
	};
}

async function migrateLegacyScope(scope: MemoryScope, cwd: string): Promise<MemoryEntry[]> {
	const raw = await fs.readFile(legacyScopePath(scope, cwd), "utf-8");
	const migrated = migrateLegacyMarkdownToJsonl(raw, { scope });
	const entries = parseMemoryEntries(migrated, { scope });
	await atomicWrite(scope, cwd, entries);
	try {
		await fs.unlink(legacyScopePath(scope, cwd));
	} catch (err: unknown) {
		if (!isNodeError(err, "ENOENT")) {
			throw err;
		}
	}
	return entries;
}

async function readScope(scope: MemoryScope, cwd: string): Promise<MemoryEntry[]> {
	try {
		const jsonl = await readJsonlScope(scope, cwd);
		if (!jsonl.migrated) {
			return jsonl.entries;
		}

		return await withFileLock(scope, cwd, async () => {
			const lockedJsonl = await readJsonlScope(scope, cwd);
			if (lockedJsonl.migrated) {
				await atomicWrite(scope, cwd, lockedJsonl.entries);
			}
			return lockedJsonl.entries;
		});
	} catch (err: unknown) {
		if (!isNodeError(err, "ENOENT")) {
			throw err;
		}
	}

	try {
		return await withFileLock(scope, cwd, async () => {
			try {
				const jsonl = await readJsonlScope(scope, cwd);
				if (jsonl.migrated) {
					await atomicWrite(scope, cwd, jsonl.entries);
				}
				return jsonl.entries;
			} catch (err: unknown) {
				if (!isNodeError(err, "ENOENT")) {
					throw err;
				}
			}

			try {
				return await migrateLegacyScope(scope, cwd);
			} catch (err: unknown) {
				if (isNodeError(err, "ENOENT")) {
					return [];
				}
				throw err;
			}
		});
	} catch (err: unknown) {
		if (isNodeError(err, "ENOENT")) {
			return [];
		}
		throw err;
	}
}

async function atomicWrite(scope: MemoryScope, cwd: string, entries: readonly MemoryEntry[]): Promise<void> {
	const dirPath = directoryForScope(scope, cwd);
	await ensureDir(dirPath);
	const dest = scopePath(scope, cwd);
	const tmp = path.join(path.dirname(dest), `.mem_${crypto.randomBytes(6).toString("hex")}.tmp`);
	try {
		await fs.writeFile(tmp, serializeMemoryEntries(entries), "utf-8");
		await fs.rename(tmp, dest);
	} catch (err: unknown) {
		try {
			await fs.unlink(tmp);
		} catch {
			// best-effort cleanup
		}
		throw err;
	}
}

async function withFileLock<T>(scope: MemoryScope, cwd: string, fn: () => Promise<T>): Promise<T> {
	const dirPath = directoryForScope(scope, cwd);
	await ensureDir(dirPath);
	const targetLockPath = lockFilePath(scope, cwd);
	const maxAttempts = 50;
	const retryDelay = 100;
	const token = crypto.randomBytes(6).toString("hex");
	let fd: fs.FileHandle | undefined;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			fd = await fs.open(
				targetLockPath,
				fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL,
				0o644,
			);
			await fd.writeFile(JSON.stringify({ pid: process.pid, token }), "utf8");
			break;
		} catch (err: unknown) {
			if (!isNodeError(err, "EEXIST")) {
				throw err;
			}

			if (await shouldReclaimLock(targetLockPath)) {
				try {
					await fs.unlink(targetLockPath);
				} catch (unlinkErr: unknown) {
					if (!isNodeError(unlinkErr, "ENOENT")) {
						throw unlinkErr;
					}
				}
				continue;
			}

			if (attempt === maxAttempts - 1) {
				throw err;
			}

			await new Promise((resolve) => setTimeout(resolve, retryDelay));
		}
	}

	if (!fd) {
		throw new Error(`Failed to acquire memory lock at ${targetLockPath}`);
	}

	try {
		return await fn();
	} finally {
		await fd.close();
		try {
			await fs.unlink(targetLockPath);
		} catch {
			// ignore cleanup errors
		}
	}
}

function findEntryIndexById(entries: readonly MemoryEntry[], id: string): number {
	return entries.findIndex((entry) => entry.id === id);
}

function makeBucketSnapshot(scope: MemoryScope, cwd: string, entries: readonly MemoryEntry[]): MemoryBucketSnapshot {
	const contents = entryContents(entries);
	const chars = charCount(contents);
	const limit = scopeLimitForScope(scope);
	return {
		bucket: scope,
		path: scopePath(scope, cwd),
		entries: contents,
		chars,
		limitChars: limit,
		usagePercent: limit > 0 ? Math.floor((chars / limit) * 100) : 0,
	};
}

function makeBucketEntriesSnapshot(
	scope: MemoryScope,
	cwd: string,
	entries: readonly MemoryEntry[],
): MemoryBucketEntriesSnapshot {
	const chars = charCount(entryContents(entries));
	const limit = scopeLimitForScope(scope);
	return {
		bucket: scope,
		path: scopePath(scope, cwd),
		entries,
		chars,
		limitChars: limit,
		usagePercent: limit > 0 ? Math.floor((chars / limit) * 100) : 0,
	};
}

interface LoadedScopeEntries {
	readonly project: MemoryEntry[];
	readonly global: MemoryEntry[];
	readonly user: MemoryEntry[];
}

async function loadEntriesByScope(cwd: string): Promise<LoadedScopeEntries> {
	const [project, global, user] = await Promise.all([
		readScope("project", cwd),
		readScope("global", cwd),
		readScope("user", cwd),
	]);

	return { project, global, user };
}

async function loadSnapshotValue(cwd: string): Promise<MemorySnapshot> {
	const entries = await loadEntriesByScope(cwd);

	return {
		project: makeBucketSnapshot("project", cwd, entries.project),
		global: makeBucketSnapshot("global", cwd, entries.global),
		user: makeBucketSnapshot("user", cwd, entries.user),
	};
}

async function loadEntriesSnapshotValue(cwd: string): Promise<MemoryEntriesSnapshot> {
	const entries = await loadEntriesByScope(cwd);

	return {
		project: makeBucketEntriesSnapshot("project", cwd, entries.project),
		global: makeBucketEntriesSnapshot("global", cwd, entries.global),
		user: makeBucketEntriesSnapshot("user", cwd, entries.user),
	};
}

function makeFrozenSnapshot(entriesSnapshot: MemoryEntriesSnapshot): FrozenSnapshot {
	const index = makeMemoryIndex(entriesSnapshot);
	return {
		entriesSnapshot,
		index,
		renderedIndex: renderMemoryIndexXml(index),
	};
}

function makeEmptyFrozenSnapshot(cwd: string): FrozenSnapshot {
	const entriesSnapshot: MemoryEntriesSnapshot = {
		project: makeBucketEntriesSnapshot("project", cwd, []),
		global: makeBucketEntriesSnapshot("global", cwd, []),
		user: makeBucketEntriesSnapshot("user", cwd, []),
	};
	return makeFrozenSnapshot(entriesSnapshot);
}

export class CuratedMemory extends ServiceMap.Service<
	CuratedMemory,
	{
		readonly getSnapshot: (cwd: string) => Effect.Effect<MemorySnapshot, MemoryFileError>;
		readonly getEntriesSnapshot: (cwd: string) => Effect.Effect<MemoryEntriesSnapshot, MemoryFileError>;
		readonly reloadFrozenSnapshot: (cwd: string) => Effect.Effect<void, MemoryFileError>;
		readonly getFrozenPromptBlock: () => string;
		readonly add: (
			scope: MemoryScope,
			summary: string,
			content: string,
			cwd: string,
		) => Effect.Effect<MutationResult, MemoryMutationError>;
		readonly update: (
			scope: MemoryScope,
			id: MemoryEntryId | string,
			summary: string,
			newText: string,
			cwd: string,
		) => Effect.Effect<MutationResult, MemoryMutationError>;
		readonly remove: (
			scope: MemoryScope,
			id: MemoryEntryId | string,
			cwd: string,
		) => Effect.Effect<MutationResult, MemoryMutationError>;
		readonly read: (id: string, cwd: string) => Effect.Effect<MemoryEntry, MemoryNoMatch | MemoryFileError>;
		readonly setup: Effect.Effect<void, never, Scope.Scope>;
	}
>()("CuratedMemory") {}

export const CuratedMemoryLive = Layer.effect(
	CuratedMemory,
	Effect.gen(function* () {
		const pi = yield* PiAPI;
		const snapshotRef = yield* Ref.make<FrozenSnapshot>(makeEmptyFrozenSnapshot(process.cwd()));
		const mutex = yield* Semaphore.make(1);

		const getSnapshot = (cwd: string): Effect.Effect<MemorySnapshot, MemoryFileError> =>
			Effect.tryPromise({
				try: () => loadSnapshotValue(cwd),
				catch: (err) => new MemoryFileError({ reason: String(err) }),
			});

		const getEntriesSnapshot = (cwd: string): Effect.Effect<MemoryEntriesSnapshot, MemoryFileError> =>
			Effect.tryPromise({
				try: () => loadEntriesSnapshotValue(cwd),
				catch: (err) => new MemoryFileError({ reason: String(err) }),
			});

		const reloadFrozenSnapshot = (cwd: string): Effect.Effect<void, MemoryFileError> =>
			getEntriesSnapshot(cwd).pipe(
				Effect.map(makeFrozenSnapshot),
				Effect.flatMap((snapshot) => Ref.set(snapshotRef, snapshot)),
			);

		const getFrozenPromptBlock = (): string => {
			let rendered = "";
			Effect.runSync(
				Ref.get(snapshotRef).pipe(
					Effect.map((snapshot) => {
						rendered = snapshot.renderedIndex;
					}),
				),
			);
			return rendered;
		};

		const mutate = (
			scope: MemoryScope,
			cwd: string,
			fn: (
				entries: MemoryEntry[],
			) => Effect.Effect<{ readonly nextEntries: MemoryEntry[]; readonly entry: MemoryEntry }, MemoryMutationError>,
		): Effect.Effect<MutationResult, MemoryMutationError> =>
			mutex.withPermits(1)(
				Effect.tryPromise({
					try: () => readScope(scope, cwd),
					catch: (err) => new MemoryFileError({ reason: String(err) }),
				}).pipe(
					Effect.flatMap(fn),
					Effect.flatMap(({ nextEntries, entry }) =>
						Effect.tryPromise({
							try: () =>
								withFileLock(scope, cwd, async () => {
									await atomicWrite(scope, cwd, nextEntries);
								}),
							catch: (err) => new MemoryFileError({ reason: String(err) }),
						}).pipe(Effect.as(entry)),
					),
					Effect.map((entry) => ({
						changedScope: scope,
						entry,
					} satisfies MutationResult)),
				),
			);

		const add = (
			scope: MemoryScope,
			summary: string,
			content: string,
			cwd: string,
		): Effect.Effect<MutationResult, MemoryMutationError> => {
			const draft = normalizeMemoryDraft(summary, content);
			if (!draft.summary) {
				return Effect.fail(new MemoryEmptySummary());
			}
			if (!draft.content) {
				return Effect.fail(new MemoryEmptyContent());
			}
			if (memorySummaryMatchesContent(draft.summary, draft.content)) {
				return Effect.fail(new MemorySummaryMatchesContent());
			}

			return mutate(scope, cwd, (entries) => {
				const existingEntry = entries.find((entry) => entry.content === draft.content);
				if (existingEntry) {
					return Effect.fail(new MemoryDuplicateEntry({ scope, entry: existingEntry }));
				}

				const existingSummary = entries.find((entry) => entry.summary === draft.summary);
				if (existingSummary) {
					return Effect.fail(new MemoryDuplicateSummary({ scope, entry: existingSummary }));
				}

				const currentChars = charCount(entryContents(entries));
				const entry = createMemoryEntry(draft.content, { scope, summary: draft.summary });
				const nextEntries = [...entries, entry];
				const nextChars = charCount(entryContents(nextEntries));
				const limit = scopeLimitForScope(scope);
				if (nextChars > limit) {
					return Effect.fail(
						new MemoryEntryTooLarge({
							scope,
							limitChars: limit,
							currentChars,
							entryChars: nextChars,
						}),
					);
				}
				return Effect.succeed({ nextEntries, entry });
			});
		};

		const update = (
			scope: MemoryScope,
			id: MemoryEntryId | string,
			summary: string,
			newText: string,
			cwd: string,
		): Effect.Effect<MutationResult, MemoryMutationError> => {
			const trimmedId = id.trim();
			const draft = normalizeMemoryDraft(summary, newText);
			if (!trimmedId) {
				return Effect.fail(new MemoryEmptyContent());
			}
			if (!draft.summary) {
				return Effect.fail(new MemoryEmptySummary());
			}
			if (!draft.content) {
				return Effect.fail(new MemoryEmptyContent());
			}
			if (memorySummaryMatchesContent(draft.summary, draft.content)) {
				return Effect.fail(new MemorySummaryMatchesContent());
			}

			return mutate(scope, cwd, (entries) => {
				const index = findEntryIndexById(entries, trimmedId);
				if (index === -1) {
					return Effect.fail(new MemoryNoMatch({ id: trimmedId }));
				}

				if (entries.some((entry, entryIndex) => entryIndex !== index && entry.content === draft.content)) {
					const existingEntry = entries.find((entry, entryIndex) => entryIndex !== index && entry.content === draft.content);
					if (!existingEntry) {
						return Effect.die(new Error("Expected duplicate memory entry to exist"));
					}
					return Effect.fail(new MemoryDuplicateEntry({ scope, entry: existingEntry }));
				}

				if (entries.some((entry, entryIndex) => entryIndex !== index && entry.summary === draft.summary)) {
					const existingSummary = entries.find((entry, entryIndex) => entryIndex !== index && entry.summary === draft.summary);
					if (!existingSummary) {
						return Effect.die(new Error("Expected duplicate memory summary to exist"));
					}
					return Effect.fail(new MemoryDuplicateSummary({ scope, entry: existingSummary }));
				}

				const candidate = [...entries];
				const currentChars = charCount(entryContents(entries));
				const currentEntry = candidate[index]!;
				const entry = createMemoryEntry(draft.content, {
					scope,
					type: currentEntry.type,
					summary: draft.summary,
					id: currentEntry.id,
					createdAt: currentEntry.createdAt,
					updatedAt: DateTime.nowUnsafe(),
				});
				candidate[index] = entry;
				const nextChars = charCount(entryContents(candidate));
				const limit = scopeLimitForScope(scope);
				if (nextChars > limit) {
					return Effect.fail(
						new MemoryEntryTooLarge({
							scope,
							limitChars: limit,
							currentChars,
							entryChars: nextChars,
						}),
					);
				}

				return Effect.succeed({ nextEntries: candidate, entry });
			});
		};

		const remove = (
			scope: MemoryScope,
			id: MemoryEntryId | string,
			cwd: string,
		): Effect.Effect<MutationResult, MemoryMutationError> => {
			const trimmedId = id.trim();
			if (!trimmedId) {
				return Effect.fail(new MemoryEmptyContent());
			}

			return mutate(scope, cwd, (entries) => {
				const index = findEntryIndexById(entries, trimmedId);
				if (index === -1) {
					return Effect.fail(new MemoryNoMatch({ id: trimmedId }));
				}

				const candidate = [...entries];
				const [entry] = candidate.splice(index, 1);
				if (!entry) {
					return Effect.die(new Error("Expected memory entry to remove"));
				}
				return Effect.succeed({ nextEntries: candidate, entry });
			});
		};

		const read = (id: string, cwd: string): Effect.Effect<MemoryEntry, MemoryNoMatch | MemoryFileError> => {
			const trimmedId = id.trim();
			if (!trimmedId) {
				return Effect.fail(new MemoryNoMatch({ id: "" }));
			}

			return getEntriesSnapshot(cwd).pipe(
				Effect.map((snapshot) => {
					const allEntries = [
						...snapshot.project.entries,
						...snapshot.global.entries,
						...snapshot.user.entries,
					];
					const entry = allEntries.find((e) => e.id === trimmedId);
					if (!entry) {
						return Effect.fail(new MemoryNoMatch({ id: trimmedId }));
					}
					return Effect.succeed(entry);
				}),
				Effect.flatMap((result) => result),
			);
		};

		return CuratedMemory.of({
			getSnapshot,
			getEntriesSnapshot,
			reloadFrozenSnapshot,
			getFrozenPromptBlock,
			add,
			update,
			remove,
			read,
			setup: Effect.gen(function* () {
				yield* reloadFrozenSnapshot(process.cwd()).pipe(Effect.orElseSucceed(() => undefined));
				yield* Effect.sync(() => {
					const reload = async (_event: unknown, ctx: ExtensionContext) => {
						await Effect.runPromise(reloadFrozenSnapshot(ctx.cwd).pipe(Effect.orElseSucceed(() => undefined)));
					};
					pi.on("session_start", reload);
					pi.on("session_switch", reload);
					pi.on("before_agent_start", async (event) => {
						const block = getFrozenPromptBlock();
						if (!block) {
							return { systemPrompt: event.systemPrompt };
						}
						const guidance = [
							block,
							"",
							"The index above shows only summaries. Use `memory` tool with action `read` and the entry `id` to fetch full content before relying on any entry.",
						].join("\n");
						return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
					});
				});
			}),
		});
	}),
);
