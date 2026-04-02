import { Clock, Effect, Fiber, Layer, Option, Ref, Scope } from "effect";
import { describe, expect, it } from "vitest";

import type {
	DreamConsolidationPlan,
	DreamMutation,
	DreamProgressEvent,
	DreamRunRequest,
	DreamRunResult,
	DreamSubagentRequest,
	DreamTaskHandle,
	DreamTranscriptCandidate,
} from "../src/dream/domain.js";
import type { DreamConfig } from "../src/dream/config.js";
import type {
	DreamConfigError,
	DreamLockError,
	DreamSubagentError,
} from "../src/dream/errors.js";
import {
	DreamDisabled,
	DreamLockHeld,
	DreamLockIoError,
} from "../src/dream/errors.js";
import { DreamLock, type DreamLease, type DreamLockInfo } from "../src/dream/lock.js";
import { DreamScheduler, type DreamSchedulerApi } from "../src/dream/scheduler.js";
import { DreamTaskRegistry, DreamTaskRegistryLive, type DreamRunError } from "../src/dream/task-registry.js";
import { DreamSubagent, type DreamSubagentContext } from "../src/dream/subagent.js";
import { DreamRunner, DreamRunnerLive, type DreamRunnerLiveConfig } from "../src/dream/runner.js";
import { CuratedMemory, type MutationResult } from "../src/services/curated-memory.js";
import type { MemoryEntriesSnapshot, MemoryEntry, MemoryBucketEntriesSnapshot } from "../src/memory/format.js";
import type { MemoryFileError, MemoryMutationError } from "../src/memory/errors.js";
import { MemoryDuplicateEntry, MemoryNoMatch } from "../src/memory/errors.js";
import { createMemoryEntry } from "../src/memory/format.js";
import { DateTime } from "effect";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeBucket(
	bucket: "project" | "global" | "user",
	entries: MemoryEntry[] = [],
	limitChars = 2048,
): MemoryBucketEntriesSnapshot {
	const chars = entries.reduce((sum, e) => sum + e.content.length, 0);
	return {
		bucket,
		path: `/fake/.pi/tau/memories/${bucket.toUpperCase()}.jsonl`,
		entries,
		chars,
		limitChars,
		usagePercent: Math.round((chars / limitChars) * 100),
	};
}

function makeEmptySnapshot(): MemoryEntriesSnapshot {
	return {
		project: makeBucket("project"),
		global: makeBucket("global"),
		user: makeBucket("user", [], 1024),
	};
}

function makeEntry(id: string, scope: "project" | "global" | "user", content: string): MemoryEntry {
	return createMemoryEntry(content, {
		id,
		scope,
		now: DateTime.makeUnsafe("2025-01-01T00:00:00Z"),
	});
}

const defaultConfig: DreamConfig = {
	enabled: true,
	manual: { enabled: true },
	auto: {
		enabled: true,
		minHoursSinceLastRun: 24,
		minSessionsSinceLastRun: 5,
		scanThrottleMinutes: 10,
	},
	subagent: {
		model: "test/test-model",
		thinking: "medium",
		maxTurns: 4,
	},
};

const defaultRequest: DreamRunRequest = {
	cwd: "/tmp/test-dream",
	mode: "manual",
	requestedBy: "user",
};

function makePlan(ops: DreamMutation[] = []): DreamConsolidationPlan {
	return {
		summary: "Test plan",
		reviewedSessions: ["sess-1"],
		pruneNotes: [],
		operations: ops,
	};
}

// ---------------------------------------------------------------------------
// Mock layers
// ---------------------------------------------------------------------------

function makeMockLock(opts: {
	acquireFail?: DreamLockError;
	inspectResult?: Option.Option<DreamLockInfo>;
} = {}): Layer.Layer<DreamLock> {
	return Layer.succeed(
		DreamLock,
		DreamLock.of({
			acquire: (_cwd) => {
				if (opts.acquireFail) {
					return Effect.fail(opts.acquireFail);
				}
				const lease: DreamLease = { path: "/tmp/test-dream/.pi/tau/dream.lock", acquiredAtMs: Date.now() };
				return Effect.acquireRelease(
					Effect.succeed(lease),
					() => Effect.void,
				);
			},
			inspect: (_cwd) => Effect.succeed(opts.inspectResult ?? Option.none()),
		}),
	);
}

function makeMockScheduler(opts: {
	lastCompletedAt?: number | null;
	evaluateAutoFail?: DreamConfigError | import("../src/dream/errors.js").DreamGateError | DreamLockError;
} = {}): Layer.Layer<DreamScheduler> {
	return Layer.succeed(
		DreamScheduler,
		DreamScheduler.of({
			evaluateAutoStart: (_request) => {
				if (opts.evaluateAutoFail) {
					return Effect.fail(opts.evaluateAutoFail);
				}
				return Effect.succeed({
					sinceMs: 0,
					sessions: [],
				});
			},
			markCompleted: () => Effect.void,
			readLastCompletedAt: () => Effect.succeed(opts.lastCompletedAt ?? null),
		}),
	);
}

function makeMockSubagent(plan: DreamConsolidationPlan): Layer.Layer<DreamSubagent> {
	return Layer.succeed(
		DreamSubagent,
		DreamSubagent.of({
			plan: (_req, _ctx, _onEvent) => Effect.succeed(plan),
		}),
	);
}

function makeMockMemory(opts: {
	snapshot?: MemoryEntriesSnapshot;
	addResult?: MutationResult;
	updateResult?: MutationResult;
	removeResult?: MutationResult;
	addFail?: MemoryMutationError;
} = {}): Layer.Layer<CuratedMemory> {
	const snapshot = opts.snapshot ?? makeEmptySnapshot();
	const defaultResult: MutationResult = {
		changedScope: "project",
		entry: makeEntry("abc123456789", "project", "test"),
	};

	return Layer.succeed(
		CuratedMemory,
		CuratedMemory.of({
			getSnapshot: () => Effect.die("not implemented in mock"),
			getEntriesSnapshot: () => Effect.succeed(snapshot),
			reloadFrozenSnapshot: () => Effect.void,
			getFrozenPromptBlock: () => "",
			add: (_scope, _text, _cwd) => {
				if (opts.addFail) return Effect.fail(opts.addFail);
				return Effect.succeed(opts.addResult ?? defaultResult);
			},
			update: (_scope, _id, _text, _cwd) =>
				Effect.succeed(opts.updateResult ?? defaultResult),
			remove: (_scope, _id, _cwd) =>
				Effect.succeed(opts.removeResult ?? defaultResult),
			read: () => Effect.die("not implemented in mock"),
			setup: Effect.void,
		}),
	);
}

const testRunnerConfig: DreamRunnerLiveConfig = {
	loadConfig: () => Effect.succeed(defaultConfig),
	modelRegistry: {
		getAll: () => [],
		find: () => undefined,
		getApiKey: () => Promise.resolve(null),
		getApiKeyForProvider: () => Promise.resolve(null),
		isUsingOAuth: () => false,
	} as unknown as import("@mariozechner/pi-coding-agent").ModelRegistry,
};

function runnerLayer(
	overrides: {
		config?: DreamRunnerLiveConfig;
		lock?: Layer.Layer<DreamLock>;
		scheduler?: Layer.Layer<DreamScheduler>;
		subagent?: Layer.Layer<DreamSubagent>;
		memory?: Layer.Layer<CuratedMemory>;
	} = {},
): Layer.Layer<DreamRunner> {
	return DreamRunnerLive(overrides.config ?? testRunnerConfig).pipe(
		Layer.provide(overrides.lock ?? makeMockLock()),
		Layer.provide(overrides.scheduler ?? makeMockScheduler()),
		Layer.provide(DreamTaskRegistryLive),
		Layer.provide(overrides.subagent ?? makeMockSubagent(makePlan())),
		Layer.provide(overrides.memory ?? makeMockMemory()),
	);
}

function runWithRunner<A, E>(
	effect: Effect.Effect<A, E, DreamRunner>,
	overrides?: Parameters<typeof runnerLayer>[0],
): Promise<A> {
	return Effect.runPromise(
		effect.pipe(Effect.provide(runnerLayer(overrides))),
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DreamRunner", () => {
	describe("runOnce", () => {
		it("succeeds with an empty plan", async () => {
			const result = await runWithRunner(
				Effect.gen(function* () {
					const runner = yield* DreamRunner;
					return yield* runner.runOnce(defaultRequest);
				}),
			);

			expect(result.mode).toBe("manual");
			expect(result.plan.operations).toHaveLength(0);
			expect(result.applied).toHaveLength(0);
		});

		it("applies add operations from the plan", async () => {
			const plan = makePlan([
				{
					_tag: "add",
					scope: "project",
					content: "new fact",
					rationale: "test",
				},
			]);

			const result = await runWithRunner(
				Effect.gen(function* () {
					const runner = yield* DreamRunner;
					return yield* runner.runOnce(defaultRequest);
				}),
				{ subagent: makeMockSubagent(plan) },
			);

			expect(result.plan.operations).toHaveLength(1);
			expect(result.applied).toHaveLength(1);
		});

		it("fails when dream is disabled", async () => {
			const disabledConfig: DreamRunnerLiveConfig = {
				...testRunnerConfig,
				loadConfig: () =>
					Effect.succeed({ ...defaultConfig, enabled: false }),
			};

			const result = Effect.gen(function* () {
				const runner = yield* DreamRunner;
				return yield* runner.runOnce(defaultRequest);
			});

			await expect(
				runWithRunner(result, { config: disabledConfig }),
			).rejects.toThrow();
		});

		it("fails when manual mode is disabled for manual request", async () => {
			const config: DreamRunnerLiveConfig = {
				...testRunnerConfig,
				loadConfig: () =>
					Effect.succeed({
						...defaultConfig,
						manual: { enabled: false },
					}),
			};

			const result = Effect.gen(function* () {
				const runner = yield* DreamRunner;
				return yield* runner.runOnce(defaultRequest);
			});

			await expect(
				runWithRunner(result, { config }),
			).rejects.toThrow();
		});

		it("soft-fails duplicate entries in auto mode", async () => {
			const plan = makePlan([
				{ _tag: "add", scope: "project", content: "dup", rationale: "test" },
			]);

			const entry = makeEntry("abc123456789", "project", "dup");
			const dupError = new MemoryDuplicateEntry({ scope: "project", entry });

			const autoRequest: DreamRunRequest = {
				...defaultRequest,
				mode: "auto",
				requestedBy: "scheduler",
			};

			const result = await runWithRunner(
				Effect.gen(function* () {
					const runner = yield* DreamRunner;
					return yield* runner.runOnce(autoRequest);
				}),
				{
					subagent: makeMockSubagent(plan),
					memory: makeMockMemory({ addFail: dupError }),
				},
			);

			// Duplicate was soft-failed: operation not in applied
			expect(result.plan.operations).toHaveLength(1);
			expect(result.applied).toHaveLength(0);
		});
	});

	describe("spawnManual", () => {
		it("fails when lock is held", async () => {
			const lockLayer = makeMockLock({
				inspectResult: Option.some({
					path: "/tmp/test/.pi/tau/dream.lock",
					holderPid: 12345,
					acquiredAtMs: Date.now(),
				}),
			});

			const result = Effect.gen(function* () {
				const runner = yield* DreamRunner;
				return yield* runner.spawnManual(defaultRequest);
			});

			await expect(
				runWithRunner(result, { lock: lockLayer }),
			).rejects.toThrow();
		});

		it("fails when dream is disabled", async () => {
			const config: DreamRunnerLiveConfig = {
				...testRunnerConfig,
				loadConfig: () =>
					Effect.succeed({ ...defaultConfig, enabled: false }),
			};

			const result = Effect.gen(function* () {
				const runner = yield* DreamRunner;
				return yield* runner.spawnManual(defaultRequest);
			});

			await expect(
				runWithRunner(result, { config }),
			).rejects.toThrow();
		});
	});

	describe("maybeSpawnAuto", () => {
		it("returns None when auto gates fail", async () => {
			const scheduler = makeMockScheduler({
				evaluateAutoFail: new DreamDisabled({ mode: "auto" }),
			});

			const autoRequest: DreamRunRequest = {
				...defaultRequest,
				mode: "auto",
				requestedBy: "scheduler",
			};

			const result = await runWithRunner(
				Effect.gen(function* () {
					const runner = yield* DreamRunner;
					return yield* runner.maybeSpawnAuto(autoRequest);
				}),
				{ scheduler },
			);

			expect(Option.isNone(result)).toBe(true);
		});
	});
});
