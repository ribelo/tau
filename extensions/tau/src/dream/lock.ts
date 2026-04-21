import * as path from "node:path";

import { Effect, Layer, Option, ServiceMap } from "effect";
import type { Scope } from "effect";

import {
	DreamLockCorrupt,
	DreamLockHeld,
	DreamLockIoError,
	type DreamLockError,
} from "./errors.js";
import {
	acquireSharedFileLock,
	describeSharedFileLockError,
	inspectSharedFileLock,
	releaseSharedFileLock,
	SharedFileLockCorrupt,
	SharedFileLockHeld,
	SharedFileLockIoError,
	SharedFileLockTimeout,
	type SharedFileLockConfig,
	type SharedFileLockLease,
} from "../shared/lock.js";

const LOCK_STALE_MS = 5_000;
const LOCK_RETRY_DELAY_MS = 100;
const LOCK_ACQUIRE_MAX_ATTEMPTS = 50;

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

const dreamLockConfig: SharedFileLockConfig = {
	staleMs: LOCK_STALE_MS,
	retryDelayMs: LOCK_RETRY_DELAY_MS,
	maxAttempts: LOCK_ACQUIRE_MAX_ATTEMPTS,
	heldPolicy: "fail",
};

function toDreamLockError(error: unknown, lockPath: string, operation: string): DreamLockError {
	if (error instanceof DreamLockHeld || error instanceof DreamLockCorrupt || error instanceof DreamLockIoError) {
		return error;
	}
	if (error instanceof SharedFileLockHeld) {
		return new DreamLockHeld({
			path: error.path,
			...(error.holderPid !== undefined ? { holderPid: error.holderPid } : {}),
		});
	}
	if (error instanceof SharedFileLockCorrupt) {
		return new DreamLockCorrupt({
			path: error.path,
			reason: error.reason,
		});
	}
	if (error instanceof SharedFileLockTimeout) {
		return new DreamLockIoError({
			path: error.path,
			operation,
			reason: describeSharedFileLockError(error),
		});
	}
	if (error instanceof SharedFileLockIoError) {
		return new DreamLockIoError({
			path: error.path,
			operation: error.operation,
			reason: error.reason,
		});
	}
	return new DreamLockIoError({
		path: lockPath,
		operation,
		reason: String(error),
	});
}

async function acquireOwnedLease(cwd: string): Promise<OwnedDreamLease> {
	const lease = await acquireSharedFileLock(lockPathForCwd(cwd), dreamLockConfig);
	return {
		lease: {
			path: lease.path,
			acquiredAtMs: lease.acquiredAtMs,
		},
		token: lease.token,
	};
}

async function releaseOwnedLease(ownedLease: OwnedDreamLease): Promise<void> {
	const lease: SharedFileLockLease = {
		path: ownedLease.lease.path,
		token: ownedLease.token,
		acquiredAtMs: ownedLease.lease.acquiredAtMs,
	};
	await releaseSharedFileLock(lease);
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
					releaseSharedFileLock({
						path: lease.path,
						token: lease.token,
						acquiredAtMs: lease.acquiredAtMs,
					}),
				catch: () => undefined,
			}).pipe(Effect.orElseSucceed(() => undefined)),

		inspect: (cwd) =>
			Effect.tryPromise({
				try: async () => {
					const info = await inspectSharedFileLock(lockPathForCwd(cwd), dreamLockConfig);
					return info === null ? Option.none() : Option.some(info);
				},
				catch: (error) => toDreamLockError(error, lockPathForCwd(cwd), "inspect"),
			}),
	}),
);
