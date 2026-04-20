import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { Effect, Layer, Option, ServiceMap } from "effect";
import type { Scope } from "effect";

import {
	DreamLockCorrupt,
	DreamLockHeld,
	DreamLockIoError,
	type DreamLockError,
} from "./errors.js";

const LOCK_STALE_MS = 5_000;
const LOCK_RETRY_DELAY_MS = 100;
const LOCK_ACQUIRE_MAX_ATTEMPTS = 50;
const LOCK_INSPECT_MAX_ATTEMPTS = 3;

interface LockMetadata {
	readonly pid: number;
	readonly token: string;
	readonly acquiredAtMs: number;
}

type ParsedLockMetadata =
	| {
			readonly _tag: "valid";
			readonly metadata: LockMetadata;
	  }
	| {
			readonly _tag: "invalid";
			readonly reason: string;
	  };

interface LockSnapshot {
	readonly raw: string;
	readonly mtimeMs: number;
	readonly parsed: ParsedLockMetadata;
}

interface OwnedDreamLease {
	readonly lease: DreamLease;
	readonly token: string;
}

export interface DreamLease {
	readonly path: string;
	readonly acquiredAtMs: number;
}

export interface DreamLockInfo {
	readonly path: string;
	readonly holderPid?: number;
	readonly acquiredAtMs?: number;
}

/** A lease that includes the token, for manual (non-scoped) lock management. */
export interface ManualDreamLease {
	readonly path: string;
	readonly token: string;
	readonly acquiredAtMs: number;
}

export interface DreamLockApi {
	readonly acquire: (cwd: string) => Effect.Effect<DreamLease, DreamLockError, Scope.Scope>;
	readonly acquireManual: (cwd: string) => Effect.Effect<ManualDreamLease, DreamLockError>;
	readonly releaseManual: (lease: ManualDreamLease) => Effect.Effect<void>;
	readonly inspect: (cwd: string) => Effect.Effect<Option.Option<DreamLockInfo>, DreamLockError>;
}

export class DreamLock extends ServiceMap.Service<DreamLock, DreamLockApi>()("DreamLock") {}

function lockPathForCwd(cwd: string): string {
	return path.join(cwd, ".pi", "tau", "dream.lock");
}

function isNodeError(err: unknown, code: string): boolean {
	return typeof err === "object" && err !== null && "code" in err && (err as { readonly code: unknown }).code === code;
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: unknown) {
		return !isNodeError(err, "ESRCH");
	}
}

function parseLockMetadata(raw: string): ParsedLockMetadata {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error: unknown) {
		return {
			_tag: "invalid",
			reason: `Invalid lock JSON: ${String(error)}`,
		};
	}

	if (typeof parsed !== "object" || parsed === null) {
		return {
			_tag: "invalid",
			reason: "Lock payload must be a JSON object",
		};
	}

	const candidate = parsed as Record<string, unknown>;
	const pid = candidate["pid"];
	const token = candidate["token"];
	const acquiredAtMs = candidate["acquiredAtMs"];

	if (
		typeof pid !== "number" ||
		!Number.isFinite(pid) ||
		typeof token !== "string" ||
		typeof acquiredAtMs !== "number" ||
		!Number.isFinite(acquiredAtMs)
	) {
		return {
			_tag: "invalid",
			reason: "Lock payload must include numeric pid/acquiredAtMs and string token",
		};
	}

	return {
		_tag: "valid",
		metadata: {
			pid,
			token,
			acquiredAtMs,
		},
	};
}

function createLockToken(): string {
	return crypto.randomBytes(8).toString("hex");
}

async function sleep(ms: number): Promise<void> {
	await new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});
}

function toDreamLockIoError(pathValue: string, operation: string, error: unknown): DreamLockIoError {
	return new DreamLockIoError({
		path: pathValue,
		operation,
		reason: String(error),
	});
}

function isDreamLockError(error: unknown): error is DreamLockError {
	if (typeof error !== "object" || error === null || !("_tag" in error)) {
		return false;
	}

	const tag = (error as { readonly _tag: unknown })._tag;
	return tag === "DreamLockHeld" || tag === "DreamLockCorrupt" || tag === "DreamLockIoError";
}

function toDreamLockError(error: unknown, lockPath: string, operation: string): DreamLockError {
	if (isDreamLockError(error)) {
		return error;
	}
	return toDreamLockIoError(lockPath, operation, error);
}

async function ensureLockDirectory(lockPath: string): Promise<void> {
	try {
		await fs.mkdir(path.dirname(lockPath), { recursive: true });
	} catch (error: unknown) {
		throw toDreamLockIoError(lockPath, "mkdir", error);
	}
}

async function readLockSnapshot(lockPath: string): Promise<LockSnapshot | null> {
	try {
		const [stats, raw] = await Promise.all([fs.stat(lockPath), fs.readFile(lockPath, "utf8")]);
		return {
			raw,
			mtimeMs: stats.mtimeMs,
			parsed: parseLockMetadata(raw),
		};
	} catch (error: unknown) {
		if (isNodeError(error, "ENOENT")) {
			return null;
		}
		throw toDreamLockIoError(lockPath, "read", error);
	}
}

function isReclaimable(snapshot: LockSnapshot): boolean {
	if (snapshot.parsed._tag === "invalid") {
		const now = Date.now();
		return now - snapshot.mtimeMs > LOCK_STALE_MS;
	}

	const metadata = snapshot.parsed.metadata;
	return !processExists(metadata.pid);
}

async function reclaimLockIfUnchanged(lockPath: string, expectedRaw: string): Promise<boolean> {
	let currentRaw: string;
	try {
		currentRaw = await fs.readFile(lockPath, "utf8");
	} catch (error: unknown) {
		if (isNodeError(error, "ENOENT")) {
			return false;
		}
		throw toDreamLockIoError(lockPath, "reclaim-read", error);
	}

	if (currentRaw !== expectedRaw) {
		return false;
	}

	try {
		await fs.unlink(lockPath);
		return true;
	} catch (error: unknown) {
		if (isNodeError(error, "ENOENT")) {
			return false;
		}
		throw toDreamLockIoError(lockPath, "reclaim-unlink", error);
	}
}

async function inspectLock(cwd: string): Promise<Option.Option<DreamLockInfo>> {
	const lockPath = lockPathForCwd(cwd);

	for (let attempt = 0; attempt < LOCK_INSPECT_MAX_ATTEMPTS; attempt += 1) {
		const snapshot = await readLockSnapshot(lockPath);
		if (snapshot === null) {
			return Option.none();
		}

		if (isReclaimable(snapshot)) {
			const reclaimed = await reclaimLockIfUnchanged(lockPath, snapshot.raw);
			if (reclaimed) {
				return Option.none();
			}
			continue;
		}

		if (snapshot.parsed._tag === "invalid") {
			throw new DreamLockCorrupt({
				path: lockPath,
				reason: snapshot.parsed.reason,
			});
		}

		return Option.some({
			path: lockPath,
			holderPid: snapshot.parsed.metadata.pid,
			acquiredAtMs: snapshot.parsed.metadata.acquiredAtMs,
		});
	}

	throw new DreamLockIoError({
		path: lockPath,
		operation: "inspect-race",
		reason: "Lock changed repeatedly during inspection",
	});
}

async function acquireOwnedLease(cwd: string): Promise<OwnedDreamLease> {
	const lockPath = lockPathForCwd(cwd);
	await ensureLockDirectory(lockPath);

	for (let attempt = 0; attempt < LOCK_ACQUIRE_MAX_ATTEMPTS; attempt += 1) {
		const token = createLockToken();
		const acquiredAtMs = Date.now();
		const metadata: LockMetadata = {
			pid: process.pid,
			token,
			acquiredAtMs,
		};

		try {
			await fs.writeFile(lockPath, JSON.stringify(metadata), {
				encoding: "utf8",
				flag: "wx",
			});

			return {
				lease: {
					path: lockPath,
					acquiredAtMs,
				},
				token,
			};
		} catch (error: unknown) {
			if (!isNodeError(error, "EEXIST")) {
				throw toDreamLockIoError(lockPath, "acquire-write", error);
			}

			const snapshot = await readLockSnapshot(lockPath);
			if (snapshot === null) {
				await sleep(LOCK_RETRY_DELAY_MS);
				continue;
			}

			if (isReclaimable(snapshot)) {
				const reclaimed = await reclaimLockIfUnchanged(lockPath, snapshot.raw);
				if (!reclaimed) {
					await sleep(LOCK_RETRY_DELAY_MS);
				}
				continue;
			}

			if (snapshot.parsed._tag === "invalid") {
				throw new DreamLockCorrupt({
					path: lockPath,
					reason: snapshot.parsed.reason,
				});
			}

			throw new DreamLockHeld({
				path: lockPath,
				holderPid: snapshot.parsed.metadata.pid,
			});
		}
	}

	throw new DreamLockIoError({
		path: lockPath,
		operation: "acquire-timeout",
		reason: `Failed to acquire dream lock after ${LOCK_ACQUIRE_MAX_ATTEMPTS} attempts`,
	});
}

async function releaseOwnedLease(ownedLease: OwnedDreamLease): Promise<void> {
	const lockPath = ownedLease.lease.path;

	let raw: string;
	try {
		raw = await fs.readFile(lockPath, "utf8");
	} catch (error: unknown) {
		if (isNodeError(error, "ENOENT")) {
			return;
		}
		return;
	}

	const parsed = parseLockMetadata(raw);
	if (parsed._tag !== "valid") {
		return;
	}

	if (parsed.metadata.token !== ownedLease.token) {
		return;
	}

	try {
		await fs.unlink(lockPath);
	} catch (error: unknown) {
		if (isNodeError(error, "ENOENT")) {
			return;
		}
	}
}

export const DreamLockLive = Layer.succeed(
	DreamLock,
	DreamLock.of({
		acquire: (cwd) =>
			Effect.acquireRelease(
				Effect.tryPromise({
					try: () => acquireOwnedLease(cwd),
					catch: (error) => toDreamLockError(error, lockPathForCwd(cwd), "acquire"),
				}),
				(ownedLease) =>
					Effect.tryPromise({
						try: () => releaseOwnedLease(ownedLease),
						catch: () => undefined,
					}).pipe(Effect.orElseSucceed(() => undefined)),
			).pipe(Effect.map((ownedLease) => ownedLease.lease)),

		acquireManual: (cwd) =>
			Effect.tryPromise({
				try: () => acquireOwnedLease(cwd),
				catch: (error) => toDreamLockError(error, lockPathForCwd(cwd), "acquireManual"),
			}).pipe(
				Effect.map((ownedLease) => ({
					path: ownedLease.lease.path,
					token: ownedLease.token,
					acquiredAtMs: ownedLease.lease.acquiredAtMs,
				})),
			),

		releaseManual: (lease) =>
			Effect.tryPromise({
				try: () =>
					releaseOwnedLease({
						lease: { path: lease.path, acquiredAtMs: lease.acquiredAtMs },
						token: lease.token,
					}),
				catch: () => undefined,
			}).pipe(Effect.orElseSucceed(() => undefined)),

		inspect: (cwd) =>
			Effect.tryPromise({
				try: () => inspectLock(cwd),
				catch: (error) => toDreamLockError(error, lockPathForCwd(cwd), "inspect"),
			}),
	}),
);
