import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { Effect, Layer, Ref, Semaphore, ServiceMap } from "effect";
import type { Scope } from "effect";

import { PiAPI } from "../effect/pi.js";
import {
	type MemoryBucket,
	charCount,
	joinEntries,
	parseEntries,
	renderPromptBlock,
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
import { getTauMemoryDir } from "../shared/discovery.js";

const MEMORY_CHAR_LIMIT = 2200;
const USER_CHAR_LIMIT = 1375;

interface BucketSnapshot {
	readonly entries: readonly string[];
	readonly chars: number;
}

interface FrozenSnapshot {
	readonly promptBlock: string;
	readonly memory: BucketSnapshot;
	readonly user: BucketSnapshot;
}

const EMPTY_SNAPSHOT: FrozenSnapshot = {
	promptBlock: "",
	memory: { entries: [], chars: 0 },
	user: { entries: [], chars: 0 },
};

export interface MutationResult {
	readonly bucket: MemoryBucket;
	readonly entryCount: number;
	readonly currentChars: number;
	readonly limitChars: number;
	readonly usagePercent: number;
}

function limitForBucket(bucket: MemoryBucket): number {
	return bucket === "user" ? USER_CHAR_LIMIT : MEMORY_CHAR_LIMIT;
}

function fileNameForBucket(bucket: MemoryBucket): string {
	return bucket === "user" ? "USER.md" : "MEMORY.md";
}

function bucketPath(bucket: MemoryBucket): string {
	return path.join(getTauMemoryDir(), fileNameForBucket(bucket));
}

function lockFilePath(): string {
	return path.join(getTauMemoryDir(), ".lock");
}

async function ensureDir(): Promise<void> {
	await fs.mkdir(getTauMemoryDir(), { recursive: true });
}

function isNodeError(err: unknown, code: string): boolean {
	return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === code;
}

async function readBucket(bucket: MemoryBucket): Promise<string[]> {
	try {
		const raw = await fs.readFile(bucketPath(bucket), "utf-8");
		const entries = parseEntries(raw);
		return [...new Set(entries)];
	} catch (err: unknown) {
		if (isNodeError(err, "ENOENT")) return [];
		throw err;
	}
}

async function atomicWrite(bucket: MemoryBucket, entries: readonly string[]): Promise<void> {
	await ensureDir();
	const dest = bucketPath(bucket);
	const tmp = path.join(path.dirname(dest), `.mem_${crypto.randomBytes(6).toString("hex")}.tmp`);
	try {
		await fs.writeFile(tmp, joinEntries(entries), "utf-8");
		await fs.rename(tmp, dest);
	} catch (err: unknown) {
		try { await fs.unlink(tmp); } catch { /* best-effort cleanup */ }
		throw err;
	}
}

async function withFileLock<T>(fn: () => Promise<T>): Promise<T> {
	await ensureDir();
	const lp = lockFilePath();
	const maxAttempts = 50;
	const retryDelay = 100;
	let fd: fs.FileHandle | undefined;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			fd = await fs.open(lp, fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL, 0o644);
			break;
		} catch (err: unknown) {
			if (isNodeError(err, "EEXIST") && attempt < maxAttempts - 1) {
				await new Promise((r) => setTimeout(r, retryDelay));
				continue;
			}
			if (isNodeError(err, "EEXIST")) {
				try { await fs.unlink(lp); } catch { /* stale lock */ }
				fd = await fs.open(lp, fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL, 0o644);
				break;
			}
			throw err;
		}
	}
	try {
		return await fn();
	} finally {
		if (fd) {
			await fd.close();
			try { await fs.unlink(lp); } catch { /* ignore */ }
		}
	}
}

function findMatchingEntries(entries: readonly string[], substring: string): number[] {
	const indices: number[] = [];
	for (let i = 0; i < entries.length; i++) {
		if (entries[i]!.includes(substring)) indices.push(i);
	}
	return indices;
}

function preview(entry: string): string {
	return entry.length > 80 ? `${entry.slice(0, 80)}...` : entry;
}

function makeMutationResult(bucket: MemoryBucket, entries: readonly string[]): MutationResult {
	const limit = limitForBucket(bucket);
	const chars = charCount(entries);
	return { bucket, entryCount: entries.length, currentChars: chars, limitChars: limit, usagePercent: limit > 0 ? Math.floor((chars / limit) * 100) : 0 };
}

export class CuratedMemory extends ServiceMap.Service<
	CuratedMemory,
	{
		readonly reloadFrozenSnapshot: Effect.Effect<void, MemoryFileError>;
		readonly getFrozenPromptBlock: () => string;
		readonly add: (bucket: MemoryBucket, text: string) => Effect.Effect<MutationResult, MemoryMutationError>;
		readonly replace: (bucket: MemoryBucket, oldText: string, newText: string) => Effect.Effect<MutationResult, MemoryMutationError>;
		readonly remove: (bucket: MemoryBucket, oldText: string) => Effect.Effect<MutationResult, MemoryMutationError>;
		readonly setup: Effect.Effect<void, never, Scope.Scope>;
	}
>()("CuratedMemory") {}

export const CuratedMemoryLive = Layer.effect(
	CuratedMemory,
	Effect.gen(function* () {
		const pi = yield* PiAPI;
		const snapshotRef = yield* Ref.make<FrozenSnapshot>(EMPTY_SNAPSHOT);
		const mutex = yield* Semaphore.make(1);

		const loadSnapshot = Effect.tryPromise({
			try: async () => {
				const [memEntries, userEntries] = await Promise.all([readBucket("memory"), readBucket("user")]);
				const memBlock = renderPromptBlock("memory", memEntries, MEMORY_CHAR_LIMIT);
				const userBlock = renderPromptBlock("user", userEntries, USER_CHAR_LIMIT);
				const parts = [memBlock, userBlock].filter((b) => b.length > 0);
				return { promptBlock: parts.join("\n"), memory: { entries: memEntries, chars: charCount(memEntries) }, user: { entries: userEntries, chars: charCount(userEntries) } } satisfies FrozenSnapshot;
			},
			catch: (err) => new MemoryFileError({ reason: String(err) }),
		});

		const reloadFrozenSnapshot = loadSnapshot.pipe(Effect.flatMap((snap) => Ref.set(snapshotRef, snap)));

		const getFrozenPromptBlock = (): string => {
			let result = "";
			Effect.runSync(Ref.get(snapshotRef).pipe(Effect.map((s) => { result = s.promptBlock; })));
			return result;
		};

		const mutate = (
			bucket: MemoryBucket,
			fn: (entries: string[]) => Effect.Effect<string[], MemoryMutationError>,
		): Effect.Effect<MutationResult, MemoryMutationError> =>
			mutex.withPermits(1)(
				Effect.tryPromise({ try: () => withFileLock(() => readBucket(bucket)), catch: (err) => new MemoryFileError({ reason: String(err) }) }).pipe(
					Effect.flatMap(fn),
					Effect.flatMap((newEntries) =>
						Effect.tryPromise({ try: () => withFileLock(async () => { await atomicWrite(bucket, newEntries); return newEntries; }), catch: (err) => new MemoryFileError({ reason: String(err) }) }),
					),
					Effect.map((newEntries) => makeMutationResult(bucket, newEntries)),
				),
			);

		const add = (bucket: MemoryBucket, text: string): Effect.Effect<MutationResult, MemoryMutationError> => {
			const trimmed = text.trim();
			if (!trimmed) return Effect.fail(new MemoryEmptyContent());
			return mutate(bucket, (entries) => {
				if (entries.includes(trimmed)) return Effect.fail(new MemoryDuplicateEntry());
				const candidate = [...entries, trimmed];
				const limit = limitForBucket(bucket);
				if (charCount(candidate) > limit) return Effect.fail(new MemoryLimitExceeded({ currentChars: charCount(entries), limitChars: limit, entryChars: trimmed.length, currentEntries: entries }));
				return Effect.succeed(candidate);
			});
		};

		const replace = (bucket: MemoryBucket, oldText: string, newText: string): Effect.Effect<MutationResult, MemoryMutationError> => {
			const oldTrimmed = oldText.trim();
			const newTrimmed = newText.trim();
			if (!oldTrimmed || !newTrimmed) return Effect.fail(new MemoryEmptyContent());
			return mutate(bucket, (entries) => {
				const matches = findMatchingEntries(entries, oldTrimmed);
				if (matches.length === 0) return Effect.fail(new MemoryNoMatch({ substring: oldTrimmed }));
				const uniqueTexts = new Set(matches.map((i) => entries[i]));
				if (matches.length > 1 && uniqueTexts.size > 1) return Effect.fail(new MemoryAmbiguousMatch({ matchCount: matches.length, previews: matches.map((i) => preview(entries[i]!)) }));
				const idx = matches[0]!;
				const candidate = [...entries];
				candidate[idx] = newTrimmed;
				const limit = limitForBucket(bucket);
				if (charCount(candidate) > limit) return Effect.fail(new MemoryLimitExceeded({ currentChars: charCount(entries), limitChars: limit, entryChars: newTrimmed.length, currentEntries: entries }));
				return Effect.succeed(candidate);
			});
		};

		const remove = (bucket: MemoryBucket, oldText: string): Effect.Effect<MutationResult, MemoryMutationError> => {
			const trimmed = oldText.trim();
			if (!trimmed) return Effect.fail(new MemoryEmptyContent());
			return mutate(bucket, (entries) => {
				const matches = findMatchingEntries(entries, trimmed);
				if (matches.length === 0) return Effect.fail(new MemoryNoMatch({ substring: trimmed }));
				const uniqueTexts = new Set(matches.map((i) => entries[i]));
				if (matches.length > 1 && uniqueTexts.size > 1) return Effect.fail(new MemoryAmbiguousMatch({ matchCount: matches.length, previews: matches.map((i) => preview(entries[i]!)) }));
				const candidate = [...entries];
				candidate.splice(matches[0]!, 1);
				return Effect.succeed(candidate);
			});
		};

		return CuratedMemory.of({
			reloadFrozenSnapshot, getFrozenPromptBlock, add, replace, remove,
			setup: Effect.gen(function* () {
				yield* reloadFrozenSnapshot.pipe(Effect.orElseSucceed(() => undefined));
				yield* Effect.sync(() => {
					const reload = () => { Effect.runPromise(reloadFrozenSnapshot.pipe(Effect.orElseSucceed(() => undefined))); };
					pi.on("session_start", reload);
					pi.on("session_switch", reload);
					pi.on("before_agent_start", async (event) => {
						const block = getFrozenPromptBlock();
						if (!block) return { systemPrompt: event.systemPrompt };
						return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
					});
				});
			}),
		});
	}),
);
