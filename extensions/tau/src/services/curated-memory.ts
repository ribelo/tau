import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Effect, Layer, Ref, Semaphore, ServiceMap } from "effect";
import type { Scope } from "effect";

import { PiAPI } from "../effect/pi.js";
import {
	type MemoryBucketSnapshot,
	type MemorySnapshot,
	type MemoryScope,
	charCount,
	joinEntries,
	parseEntries,
	renderMemorySnapshotXml,
} from "../memory/format.js";
import {
	MemoryAmbiguousMatch,
	MemoryDuplicateEntry,
	MemoryEmptyContent,
	MemoryFileError,
	MemoryLimitExceeded,
	MemoryNoMatch,
	type MemoryMutationError,
} from "../memory/errors.js";
import { getProjectTauMemoryDir, getTauMemoryDir } from "../shared/discovery.js";

const PROJECT_CHAR_LIMIT = 2200;
const GLOBAL_CHAR_LIMIT = 2200;
const USER_CHAR_LIMIT = 1375;
const LOCK_STALE_MS = 5_000;

interface FrozenSnapshot {
	readonly rendered: string;
	readonly snapshot: MemorySnapshot;
}

interface LockMetadata {
	readonly pid: number;
	readonly token: string;
}

export interface MutationResult {
	readonly changedScope: MemoryScope;
	readonly snapshot: MemorySnapshot;
	readonly rendered: string;
}

function limitForScope(scope: MemoryScope): number {
	switch (scope) {
		case "project":
			return PROJECT_CHAR_LIMIT;
		case "global":
			return GLOBAL_CHAR_LIMIT;
		case "user":
			return USER_CHAR_LIMIT;
	}
}

function fileNameForScope(scope: MemoryScope): string {
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
	return text.replace(/\r\n?/gu, "\n").trim();
}

function directoryForScope(scope: MemoryScope, cwd: string): string {
	return scope === "project" ? getProjectTauMemoryDir(cwd) : getTauMemoryDir();
}

function scopePath(scope: MemoryScope, cwd: string): string {
	return path.join(directoryForScope(scope, cwd), fileNameForScope(scope));
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

async function readScope(scope: MemoryScope, cwd: string): Promise<string[]> {
	try {
		const raw = await fs.readFile(scopePath(scope, cwd), "utf-8");
		const entries = parseEntries(raw).map(normalizeEntryText);
		return [...new Set(entries)];
	} catch (err: unknown) {
		if (isNodeError(err, "ENOENT")) {
			return [];
		}
		throw err;
	}
}

async function atomicWrite(scope: MemoryScope, cwd: string, entries: readonly string[]): Promise<void> {
	const dirPath = directoryForScope(scope, cwd);
	await ensureDir(dirPath);
	const dest = scopePath(scope, cwd);
	const tmp = path.join(path.dirname(dest), `.mem_${crypto.randomBytes(6).toString("hex")}.tmp`);
	try {
		await fs.writeFile(tmp, joinEntries(entries), "utf-8");
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

function findMatchingEntries(entries: readonly string[], substring: string): number[] {
	const indices: number[] = [];
	for (let index = 0; index < entries.length; index++) {
		if (entries[index]!.includes(substring)) {
			indices.push(index);
		}
	}
	return indices;
}

function preview(entry: string): string {
	return entry.length > 80 ? `${entry.slice(0, 80)}...` : entry;
}

function makeBucketSnapshot(scope: MemoryScope, cwd: string, entries: readonly string[]): MemoryBucketSnapshot {
	const chars = charCount(entries);
	const limit = limitForScope(scope);
	return {
		bucket: scope,
		path: scopePath(scope, cwd),
		entries,
		chars,
		limitChars: limit,
		usagePercent: limit > 0 ? Math.floor((chars / limit) * 100) : 0,
	};
}

async function loadSnapshotValue(cwd: string): Promise<MemorySnapshot> {
	const [projectEntries, globalEntries, userEntries] = await Promise.all([
		readScope("project", cwd),
		readScope("global", cwd),
		readScope("user", cwd),
	]);

	return {
		project: makeBucketSnapshot("project", cwd, projectEntries),
		global: makeBucketSnapshot("global", cwd, globalEntries),
		user: makeBucketSnapshot("user", cwd, userEntries),
	};
}

function makeFrozenSnapshot(snapshot: MemorySnapshot): FrozenSnapshot {
	return {
		snapshot,
		rendered: renderMemorySnapshotXml(snapshot, { includeEmpty: false }),
	};
}

function makeEmptyFrozenSnapshot(cwd: string): FrozenSnapshot {
	return makeFrozenSnapshot({
		project: makeBucketSnapshot("project", cwd, []),
		global: makeBucketSnapshot("global", cwd, []),
		user: makeBucketSnapshot("user", cwd, []),
	});
}

export class CuratedMemory extends ServiceMap.Service<
	CuratedMemory,
	{
		readonly getSnapshot: (cwd: string) => Effect.Effect<MemorySnapshot, MemoryFileError>;
		readonly reloadFrozenSnapshot: (cwd: string) => Effect.Effect<void, MemoryFileError>;
		readonly getFrozenPromptBlock: () => string;
		readonly add: (scope: MemoryScope, text: string, cwd: string) => Effect.Effect<MutationResult, MemoryMutationError>;
		readonly update: (
			scope: MemoryScope,
			oldText: string,
			newText: string,
			cwd: string,
		) => Effect.Effect<MutationResult, MemoryMutationError>;
		readonly remove: (
			scope: MemoryScope,
			oldText: string,
			cwd: string,
		) => Effect.Effect<MutationResult, MemoryMutationError>;
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

		const reloadFrozenSnapshot = (cwd: string): Effect.Effect<void, MemoryFileError> =>
			getSnapshot(cwd).pipe(
				Effect.map(makeFrozenSnapshot),
				Effect.flatMap((snapshot) => Ref.set(snapshotRef, snapshot)),
			);

		const getFrozenPromptBlock = (): string => {
			let rendered = "";
			Effect.runSync(
				Ref.get(snapshotRef).pipe(
					Effect.map((snapshot) => {
						rendered = snapshot.rendered;
					}),
				),
			);
			return rendered;
		};

		const mutate = (
			scope: MemoryScope,
			cwd: string,
			fn: (entries: string[]) => Effect.Effect<string[], MemoryMutationError>,
		): Effect.Effect<MutationResult, MemoryMutationError> =>
			mutex.withPermits(1)(
				Effect.tryPromise({
					try: () => withFileLock(scope, cwd, () => readScope(scope, cwd)),
					catch: (err) => new MemoryFileError({ reason: String(err) }),
				}).pipe(
					Effect.flatMap(fn),
					Effect.flatMap((nextEntries) =>
						Effect.tryPromise({
							try: () =>
								withFileLock(scope, cwd, async () => {
									await atomicWrite(scope, cwd, nextEntries);
								}),
							catch: (err) => new MemoryFileError({ reason: String(err) }),
						}).pipe(Effect.as(nextEntries)),
					),
					Effect.flatMap(() => getSnapshot(cwd)),
					Effect.map((snapshot) => ({
						changedScope: scope,
						snapshot,
						rendered: renderMemorySnapshotXml(snapshot, { includeEmpty: true }),
					} satisfies MutationResult)),
				),
			);

		const add = (
			scope: MemoryScope,
			text: string,
			cwd: string,
		): Effect.Effect<MutationResult, MemoryMutationError> => {
			const trimmed = normalizeEntryText(text);
			if (!trimmed) {
				return Effect.fail(new MemoryEmptyContent());
			}

			return mutate(scope, cwd, (entries) => {
				if (entries.includes(trimmed)) {
					return Effect.fail(new MemoryDuplicateEntry());
				}

				const candidate = [...entries, trimmed];
				const limit = limitForScope(scope);
				if (charCount(candidate) > limit) {
					return Effect.fail(
						new MemoryLimitExceeded({
							currentChars: charCount(entries),
							limitChars: limit,
							entryChars: trimmed.length,
							currentEntries: entries,
						}),
					);
				}

				return Effect.succeed(candidate);
			});
		};

		const update = (
			scope: MemoryScope,
			oldText: string,
			newText: string,
			cwd: string,
		): Effect.Effect<MutationResult, MemoryMutationError> => {
			const oldTrimmed = normalizeEntryText(oldText);
			const newTrimmed = normalizeEntryText(newText);
			if (!oldTrimmed || !newTrimmed) {
				return Effect.fail(new MemoryEmptyContent());
			}

			return mutate(scope, cwd, (entries) => {
				const matches = findMatchingEntries(entries, oldTrimmed);
				if (matches.length === 0) {
					return Effect.fail(new MemoryNoMatch({ substring: oldTrimmed }));
				}

				const uniqueTexts = new Set(matches.map((index) => entries[index]));
				if (matches.length > 1 && uniqueTexts.size > 1) {
					return Effect.fail(
						new MemoryAmbiguousMatch({
							matchCount: matches.length,
							previews: matches.map((index) => preview(entries[index]!)),
						}),
					);
				}

				const index = matches[0]!;
				if (entries.some((entry, entryIndex) => entryIndex !== index && entry === newTrimmed)) {
					return Effect.fail(new MemoryDuplicateEntry());
				}

				const candidate = [...entries];
				candidate[index] = newTrimmed;
				const limit = limitForScope(scope);
				if (charCount(candidate) > limit) {
					return Effect.fail(
						new MemoryLimitExceeded({
							currentChars: charCount(entries),
							limitChars: limit,
							entryChars: newTrimmed.length,
							currentEntries: entries,
						}),
					);
				}

				return Effect.succeed(candidate);
			});
		};

		const remove = (
			scope: MemoryScope,
			oldText: string,
			cwd: string,
		): Effect.Effect<MutationResult, MemoryMutationError> => {
			const trimmed = normalizeEntryText(oldText);
			if (!trimmed) {
				return Effect.fail(new MemoryEmptyContent());
			}

			return mutate(scope, cwd, (entries) => {
				const matches = findMatchingEntries(entries, trimmed);
				if (matches.length === 0) {
					return Effect.fail(new MemoryNoMatch({ substring: trimmed }));
				}

				const uniqueTexts = new Set(matches.map((index) => entries[index]));
				if (matches.length > 1 && uniqueTexts.size > 1) {
					return Effect.fail(
						new MemoryAmbiguousMatch({
							matchCount: matches.length,
							previews: matches.map((index) => preview(entries[index]!)),
						}),
					);
				}

				const candidate = [...entries];
				candidate.splice(matches[0]!, 1);
				return Effect.succeed(candidate);
			});
		};

		return CuratedMemory.of({
			getSnapshot,
			reloadFrozenSnapshot,
			getFrozenPromptBlock,
			add,
			update,
			remove,
			setup: Effect.gen(function* () {
				yield* reloadFrozenSnapshot(process.cwd()).pipe(Effect.orElseSucceed(() => undefined));
				yield* Effect.sync(() => {
					const reload = (_event: unknown, ctx: ExtensionContext) => {
						void Effect.runPromise(reloadFrozenSnapshot(ctx.cwd).pipe(Effect.orElseSucceed(() => undefined)));
					};
					pi.on("session_start", reload);
					pi.on("session_switch", reload);
					pi.on("before_agent_start", async (event) => {
						const block = getFrozenPromptBlock();
						if (!block) {
							return { systemPrompt: event.systemPrompt };
						}
						return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
					});
				});
			}),
		});
	}),
);
