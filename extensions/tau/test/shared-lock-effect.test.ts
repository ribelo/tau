import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
	acquireSharedFileLock,
	acquireSharedFileLockEffect,
	acquireSharedFileLockScoped,
	releaseSharedFileLock,
	releaseSharedFileLockEffect,
	type SharedFileLockConfig,
} from "../src/shared/lock.js";

const TEST_LOCK_CONFIG: SharedFileLockConfig = {
	staleMs: 60_000,
	retryDelayMs: 1,
	maxAttempts: 1,
	heldPolicy: "fail",
};

describe("shared lock Effect helpers", () => {
	const cleanup = new Set<string>();

	afterEach(async () => {
		await Promise.all(
			Array.from(cleanup, (dir) => fs.rm(dir, { recursive: true, force: true })),
		);
		cleanup.clear();
	});

	it("scoped lock helper releases lock when the scope closes", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tau-shared-lock-effect-"));
		cleanup.add(workspace);
		const lockPath = path.join(workspace, "test.lock");

		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* acquireSharedFileLockScoped(lockPath, TEST_LOCK_CONFIG);
				}),
			),
		);

		const lease = await acquireSharedFileLock(lockPath, TEST_LOCK_CONFIG);
		await releaseSharedFileLock(lease);
	});

	it("non-scoped Effect helpers acquire and release locks", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tau-shared-lock-effect-"));
		cleanup.add(workspace);
		const lockPath = path.join(workspace, "test.lock");

		const lease = await Effect.runPromise(acquireSharedFileLockEffect(lockPath, TEST_LOCK_CONFIG));
		await Effect.runPromise(releaseSharedFileLockEffect(lease));

		const reacquired = await acquireSharedFileLock(lockPath, TEST_LOCK_CONFIG);
		await releaseSharedFileLock(reacquired);
	});
});
