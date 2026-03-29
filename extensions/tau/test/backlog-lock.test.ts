import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveBacklogPaths } from "../src/backlog/contract.js";
import {
	setBacklogLockTestHooksForTesting,
	withBacklogWriteLock,
} from "../src/backlog/materialize.js";

const tempDirs: string[] = [];

afterEach(async () => {
	setBacklogLockTestHooksForTesting(null);
	await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tau-backlog-lock-"));
	tempDirs.push(dir);
	return dir;
}

function lockPathFor(workspaceRoot: string): string {
	return path.join(resolveBacklogPaths(workspaceRoot).materializedCacheDir, ".lock");
}

async function listClaimArtifacts(workspaceRoot: string): Promise<ReadonlyArray<string>> {
	const cacheDir = resolveBacklogPaths(workspaceRoot).materializedCacheDir;
	try {
		return (await fs.readdir(cacheDir)).filter((entry) => entry.startsWith(".lock.claim-"));
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return [];
		}
		throw error;
	}
}

describe("backlog lock", () => {
	it("does not reclaim a stale lock while the recorded pid is still alive", async () => {
		const workspaceRoot = await makeWorkspace();
		const lockPath = lockPathFor(workspaceRoot);
		await fs.mkdir(path.dirname(lockPath), { recursive: true });
		await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, token: "live-lock" }), "utf8");
		const staleAt = new Date(Date.now() - 20_000);
		await fs.utimes(lockPath, staleAt, staleAt);

		setBacklogLockTestHooksForTesting({ maxAttempts: 2, retryDelayMs: 5 });

		await expect(withBacklogWriteLock(workspaceRoot, async () => undefined)).rejects.toThrow();
		expect(await fs.readFile(lockPath, "utf8")).toBe(JSON.stringify({ pid: process.pid, token: "live-lock" }));
		expect(await listClaimArtifacts(workspaceRoot)).toEqual([]);
	});

	it("does not unlink a newer lock when release token does not match", async () => {
		const workspaceRoot = await makeWorkspace();
		const lockPath = lockPathFor(workspaceRoot);

		setBacklogLockTestHooksForTesting({
			afterAcquire: async () => {
				await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, token: "newer-lock" }), "utf8");
			},
		});

		await withBacklogWriteLock(workspaceRoot, async () => undefined);

		expect(await fs.readFile(lockPath, "utf8")).toBe(JSON.stringify({ pid: process.pid, token: "newer-lock" }));
	});

	it("cleans up claim artifacts after successful stale reclaim", async () => {
		const workspaceRoot = await makeWorkspace();
		const lockPath = lockPathFor(workspaceRoot);
		await fs.mkdir(path.dirname(lockPath), { recursive: true });
		await fs.writeFile(lockPath, JSON.stringify({ pid: 999_999, token: "stale-lock" }), "utf8");

		await withBacklogWriteLock(workspaceRoot, async () => undefined);

		expect(await listClaimArtifacts(workspaceRoot)).toEqual([]);
	});

	it("does not let concurrent stale reclaim delete a freshly replaced lock", async () => {
		const workspaceRoot = await makeWorkspace();
		const lockPath = lockPathFor(workspaceRoot);
		await fs.mkdir(path.dirname(lockPath), { recursive: true });
		await fs.writeFile(lockPath, JSON.stringify({ pid: 999_999, token: "stale-lock" }), "utf8");

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

		const first = withBacklogWriteLock(workspaceRoot, async () => undefined);
		await firstLockAcquired;

		const second = withBacklogWriteLock(workspaceRoot, async () => undefined);
		await new Promise((resolve) => setTimeout(resolve, 50));

		const replacementRaw = await fs.readFile(lockPath, "utf8");
		const replacement = JSON.parse(replacementRaw) as { readonly pid: number; readonly token: string };
		expect(replacement.token).not.toBe("stale-lock");
		expect(acquiredCount).toBe(1);

		releaseFirstLock?.();

		await expect(first).resolves.toBeUndefined();
		await expect(second).resolves.toBeUndefined();
		expect(await listClaimArtifacts(workspaceRoot)).toEqual([]);
	});
});
