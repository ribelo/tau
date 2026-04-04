import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { describe, expect, it } from "vitest";

import type {
	DreamProgressEvent,
	DreamRunRequest,
	DreamRunResult,
	DreamTranscriptCandidate,
} from "../src/dream/domain.js";
import type { DreamConfig } from "../src/dream/config.js";
import type {
	DreamConfigError,
	DreamLockError,
} from "../src/dream/errors.js";
import {
	DreamDisabled,
} from "../src/dream/errors.js";
import { DreamLock, type DreamLease, type DreamLockInfo, type ManualDreamLease } from "../src/dream/lock.js";
import { DreamScheduler } from "../src/dream/scheduler.js";
import { DreamTaskRegistry, DreamTaskRegistryLive } from "../src/dream/task-registry.js";
import { DreamSubagent, type DreamSubagentContext, type DreamSubagentResult } from "../src/dream/subagent.js";
import { DreamRunner, DreamRunnerLive, type DreamRunnerLiveConfig } from "../src/dream/runner.js";
import { CuratedMemory, type MutationResult } from "../src/services/curated-memory.js";
import type { MemoryEntriesSnapshot, MemoryEntry, MemoryBucketEntriesSnapshot } from "../src/memory/format.js";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { createMemoryEntry } from "../src/memory/format.js";
import { DateTime } from "effect";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeBucket(
	bucket: "project" | "global" | "user",
	entries: MemoryEntry[] = [],
	limitChars = 25_000,
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
		user: makeBucket("user", [], 25_000),
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
			acquireManual: (_cwd) => {
				if (opts.acquireFail) {
					return Effect.fail(opts.acquireFail);
				}
				const lease: ManualDreamLease = {
					path: "/tmp/test-dream/.pi/tau/dream.lock",
					token: "test-token",
					acquiredAtMs: Date.now(),
				};
				return Effect.succeed(lease);
			},
			releaseManual: () => Effect.void,
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

/**
 * Create a mock subagent that simulates calling dream_finish via the
 * custom tools it receives. The `run` method finds the dream_finish tool
 * in customTools and calls its execute to capture the finish params.
 */
function makeMockSubagent(opts: {
	memoryMutations?: number;
	callFinish?: boolean;
	finishSummary?: string;
	finishReviewedSessions?: string[];
	finishNoChanges?: boolean;
} = {}): Layer.Layer<DreamSubagent> {
	const callFinish = opts.callFinish ?? true;
	return Layer.succeed(
		DreamSubagent,
		DreamSubagent.of({
			run: (request, _context, customTools, _onEvent) => {
				const callFinishAndReturn = Effect.gen(function* () {
					if (callFinish) {
						// Find the dream_finish tool and call it
						const finishTool = customTools.find((t) => t.name === "dream_finish");
						if (finishTool) {
							yield* Effect.promise(() =>
								finishTool.execute(
									"test-call-id",
									{
										runId: request.runId,
										summary: opts.finishSummary ?? "Test plan",
										reviewedSessions: opts.finishReviewedSessions ?? ["sess-1"],
										noChanges: opts.finishNoChanges ?? false,
									},
									new AbortController().signal,
									() => undefined,
									{} as Parameters<typeof finishTool.execute>[4],
								),
							);
						}
					}

					return {
						memoryMutations: opts.memoryMutations ?? 0,
					} satisfies DreamSubagentResult;
				});
				return callFinishAndReturn as Effect.Effect<DreamSubagentResult, import("../src/dream/errors.js").DreamSubagentError>;
			},
		}),
	);
}

function makeMockMemory(opts: {
	snapshot?: MemoryEntriesSnapshot;
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
			add: () => Effect.succeed(defaultResult),
			update: () => Effect.succeed(defaultResult),
			remove: () => Effect.succeed(defaultResult),
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
		Layer.provide(overrides.subagent ?? makeMockSubagent()),
		Layer.provide(overrides.memory ?? makeMockMemory()),
	);
}

function persistentRunnerLayer(
	overrides: Parameters<typeof runnerLayer>[0] = {},
): Layer.Layer<DreamRunner | DreamTaskRegistry> {
	const registryLayer = DreamTaskRegistryLive;
	const runnerWithRegistry = DreamRunnerLive(overrides.config ?? testRunnerConfig).pipe(
		Layer.provide(overrides.lock ?? makeMockLock()),
		Layer.provide(overrides.scheduler ?? makeMockScheduler()),
		Layer.provide(registryLayer),
		Layer.provide(overrides.subagent ?? makeMockSubagent()),
		Layer.provide(overrides.memory ?? makeMockMemory()),
	);

	return Layer.merge(registryLayer, runnerWithRegistry);
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
		it("succeeds with no changes", async () => {
			const result = await runWithRunner(
				Effect.gen(function* () {
					const runner = yield* DreamRunner;
					return yield* runner.runOnce(defaultRequest);
				}),
				{
					subagent: makeMockSubagent({
						finishNoChanges: true,
						finishSummary: "Nothing to do",
					}),
				},
			);

			expect(result.mode).toBe("manual");
			expect(result.noChanges).toBe(true);
			expect(result.summary).toBe("Nothing to do");
		});

		it("reports memory mutations from the subagent", async () => {
			const result = await runWithRunner(
				Effect.gen(function* () {
					const runner = yield* DreamRunner;
					return yield* runner.runOnce(defaultRequest);
				}),
				{
					subagent: makeMockSubagent({
						memoryMutations: 3,
						finishSummary: "Added 3 facts",
					}),
				},
			);

			expect(result.memoryMutations).toBe(3);
			expect(result.summary).toBe("Added 3 facts");
			expect(result.reviewedSessions).toEqual(["sess-1"]);
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
	});

	describe("spawnManual", () => {
		it("returns a task handle when dream startup succeeds", async () => {
			const handle = await runWithRunner(
				Effect.gen(function* () {
					const runner = yield* DreamRunner;
					return yield* runner.spawnManual(defaultRequest);
				}),
			);

			expect(handle.taskId).toMatch(/^[A-Za-z0-9_-]+$/);
		});

		it("continues running after spawnManual returns", async () => {
			const subagent = makeMockSubagent({
				finishSummary: "Done after delay",
			});

			const runtime = ManagedRuntime.make(
				persistentRunnerLayer({ subagent }),
			);

			try {
				const handle = await runtime.runPromise(
					Effect.gen(function* () {
						const runner = yield* DreamRunner;
						return yield* runner.spawnManual(defaultRequest);
					}),
				);

				await new Promise((resolve) => setTimeout(resolve, 50));

				const state = await runtime.runPromise(
					Effect.gen(function* () {
						const registry = yield* DreamTaskRegistry;
						return yield* registry.get(handle.taskId);
					}),
				);

				expect(state.phase).not.toBe("queued");
				expect(state.status).toBe("completed");
			} finally {
				await runtime.dispose();
			}
		});

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
