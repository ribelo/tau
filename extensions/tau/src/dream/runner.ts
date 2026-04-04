// DreamRunner -- orchestration service that coordinates lock, scheduler,
// subagent, and task registry to execute memory consolidation runs.
// The model does the work directly through tools (memory + dream_finish).

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Dirent, Stats } from "node:fs";

import { Clock, Effect, Layer, Option, Scope, ServiceMap } from "effect";
import { nanoid } from "nanoid";
import { Type, type Static } from "@sinclair/typebox";

import type { ModelRegistry, ToolDefinition } from "@mariozechner/pi-coding-agent";

import type {
	DreamFinishParams,
	DreamProgressEvent,
	DreamRunRequest,
	DreamRunResult,
	DreamTaskHandle,
	DreamTranscriptCandidate,
} from "./domain.js";
import type { DreamConfig } from "./config.js";
import type {
	DreamConfigError,
	DreamGateError,
	DreamLockError,
	DreamSubagentError,
} from "./errors.js";
import { DreamDisabled, DreamLockHeld, DreamLockIoError, DreamSubagentNoFinish } from "./errors.js";
import type { DreamRunError } from "./task-registry.js";

import { DreamLock } from "./lock.js";
import { DreamScheduler } from "./scheduler.js";
import { DreamTaskRegistry } from "./task-registry.js";
import { DreamSubagent } from "./subagent.js";
import {
	dreamTranscriptRoot,
	isDreamTranscriptFile,
	parseDreamTranscriptSessionId,
} from "./transcripts.js";
import { CuratedMemory } from "../services/curated-memory.js";
import { createMemoryToolDefinition } from "../memory/index.js";

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface DreamRunnerApi {
	readonly runOnce: (
		request: DreamRunRequest,
	) => Effect.Effect<DreamRunResult, DreamRunError>;

	readonly spawnManual: (
		request: DreamRunRequest,
	) => Effect.Effect<DreamTaskHandle, DreamConfigError | DreamGateError | DreamLockError>;

	readonly maybeSpawnAuto: (
		request: DreamRunRequest,
	) => Effect.Effect<Option.Option<DreamTaskHandle>, DreamConfigError | DreamLockError>;
}

export class DreamRunner extends ServiceMap.Service<DreamRunner, DreamRunnerApi>()(
	"DreamRunner",
) {}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface DreamRunnerLiveConfig {
	readonly loadConfig: (cwd: string) => Effect.Effect<DreamConfig, DreamConfigError>;
	readonly modelRegistry: ModelRegistry;
}

// ---------------------------------------------------------------------------
// dream_finish tool for auto-mode subagent sessions
// ---------------------------------------------------------------------------

const DreamFinishToolParams = Type.Object({
	runId: Type.String({ description: "Dream run id" }),
	summary: Type.String({ description: "Brief summary of what was found and changed" }),
	reviewedSessions: Type.Array(Type.String(), { description: "Session IDs reviewed" }),
	noChanges: Type.Boolean({ description: "True if no memory changes were made" }),
});

type DreamFinishToolParams = Static<typeof DreamFinishToolParams>;

/** Mutable holder for dream_finish params captured from the subagent. */
interface DreamFinishCapture {
	value: DreamFinishParams | undefined;
}

function createDreamFinishToolForSubagent(
	expectedRunId: string,
	capture: DreamFinishCapture,
): ToolDefinition<typeof DreamFinishToolParams> {
	return {
		name: "dream_finish",
		label: "dream_finish",
		description: "Signal that the dream memory consolidation run is complete. Call this after all memory mutations are done.",
		parameters: DreamFinishToolParams,
		async execute(_toolCallId, rawParams) {
			const params = rawParams as DreamFinishToolParams;

			if (params.runId !== expectedRunId) {
				return {
					isError: true,
					content: [{ type: "text", text: `Run id mismatch. Expected ${expectedRunId}, received ${params.runId}.` }],
					details: {},
				};
			}

			capture.value = {
				runId: params.runId,
				summary: params.summary,
				reviewedSessions: params.reviewedSessions,
				noChanges: params.noChanges,
			};

			return {
				content: [{ type: "text", text: `Dream run ${params.runId} marked complete. ${params.summary}` }],
				details: {},
			};
		},
	};
}

// ---------------------------------------------------------------------------
// Transcript scanning helpers
// ---------------------------------------------------------------------------

function isNodeError(err: unknown, code: string): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		(err as { code: unknown }).code === code
	);
}

function readDirSafe(dirPath: string): Effect.Effect<ReadonlyArray<Dirent>, DreamLockIoError> {
	return Effect.tryPromise({
		try: () => fs.readdir(dirPath, { withFileTypes: true }),
		catch: (cause) => cause,
	}).pipe(
		Effect.catchIf(
			(cause) => isNodeError(cause, "ENOENT"),
			() => Effect.succeed([] as ReadonlyArray<Dirent>),
		),
		Effect.mapError(
			(cause) =>
				new DreamLockIoError({
					path: dirPath,
					operation: "readdir",
					reason: String(cause),
				}),
		),
	);
}

function collectTranscriptFiles(dirPath: string): Effect.Effect<ReadonlyArray<string>, DreamLockIoError> {
	return Effect.gen(function* () {
		const entries = yield* readDirSafe(dirPath);
		const files: string[] = [];

		for (const entry of entries) {
			const fullPath = path.join(dirPath, entry.name);
			if (entry.isDirectory()) {
				const nested = yield* collectTranscriptFiles(fullPath);
				files.push(...nested);
			} else if (entry.isFile() && isDreamTranscriptFile(entry.name)) {
				files.push(fullPath);
			}
		}

		return files;
	});
}

function statMtimeMs(filePath: string): Effect.Effect<number | null, DreamLockIoError> {
	return Effect.tryPromise({
		try: () => fs.stat(filePath),
		catch: (cause) => cause,
	}).pipe(
		Effect.catchIf(
			(cause) => isNodeError(cause, "ENOENT"),
			() => Effect.succeed<Stats | null>(null),
		),
		Effect.mapError(
			(cause) =>
				new DreamLockIoError({
					path: filePath,
					operation: "stat",
					reason: String(cause),
				}),
		),
		Effect.map((stats) => (stats !== null && stats.isFile() ? Math.trunc(stats.mtimeMs) : null)),
	);
}

function scanTranscripts(
	cwd: string,
	sinceMs: number,
	currentSessionId: string | undefined,
): Effect.Effect<ReadonlyArray<DreamTranscriptCandidate>, DreamLockIoError> {
	return Effect.gen(function* () {
		const root = dreamTranscriptRoot(cwd);
		const files = yield* collectTranscriptFiles(root);
		const candidates: DreamTranscriptCandidate[] = [];

		for (const filePath of files) {
			const touchedAt = yield* statMtimeMs(filePath);
			if (touchedAt === null || touchedAt <= sinceMs) {
				continue;
			}

			const sessionId = parseDreamTranscriptSessionId(filePath);
			if (sessionId === null) {
				continue;
			}

			if (currentSessionId !== undefined && sessionId === currentSessionId) {
				continue;
			}

			candidates.push({ sessionId, path: filePath, touchedAt });
		}

		candidates.sort((a, b) => b.touchedAt - a.touchedAt);
		return candidates;
	});
}

// ---------------------------------------------------------------------------
// Live layer
// ---------------------------------------------------------------------------

export const DreamRunnerLive = (runtimeConfig: DreamRunnerLiveConfig) =>
	Layer.effect(
		DreamRunner,
		Effect.gen(function* () {
			const lock = yield* DreamLock;
			const scheduler = yield* DreamScheduler;
			const reg = yield* DreamTaskRegistry;
			const subagent = yield* DreamSubagent;
			const mem = yield* CuratedMemory;

			const subagentContext = {
				modelRegistry: runtimeConfig.modelRegistry,
			};

			// ── helpers ────────────────────────────────────────────────

			/** Create a memory tool that the subagent can use to mutate memory. */
			function createSubagentMemoryTool(): ToolDefinition {
				return createMemoryToolDefinition((effect) =>
					Effect.runPromise(
						effect.pipe(Effect.provideService(CuratedMemory, CuratedMemory.of(mem))),
					),
				) as unknown as ToolDefinition;
			}

			function progress(taskId: string, event: DreamProgressEvent): Effect.Effect<void> {
				return reg.report(taskId, event).pipe(Effect.catch(() => Effect.void));
			}

			function failTask(taskId: string, err: DreamRunError): Effect.Effect<never> {
				return reg.fail(taskId, err).pipe(Effect.flatMap(() => Effect.interrupt));
			}

			// ── runOnce (scoped -- caller wraps in Effect.scoped) ──────
			const runOnceScoped = Effect.fn("DreamRunner.runOnce")(
				function* (request: DreamRunRequest) {
					const startedAt = yield* Clock.currentTimeMillis;
					const dreamConfig = yield* runtimeConfig.loadConfig(request.cwd);

					if (!dreamConfig.enabled) {
						return yield* new DreamDisabled({ mode: request.mode });
					}
					if (request.mode === "manual" && !dreamConfig.manual.enabled) {
						return yield* new DreamDisabled({ mode: "manual" });
					}

					// Acquire scoped lock (released on scope exit / interruption)
					yield* lock.acquire(request.cwd);

					const memorySnapshot = yield* mem.getEntriesSnapshot(request.cwd);

					const lastCompletedAt = yield* scheduler.readLastCompletedAt(request.cwd);
					const sinceMs = lastCompletedAt ?? 0;
					const transcriptCandidates = yield* scanTranscripts(
						request.cwd,
						sinceMs,
						request.currentSessionId,
					);

					const runId = nanoid(12);
					const finishCapture: DreamFinishCapture = { value: undefined };
					const dreamFinishTool = createDreamFinishToolForSubagent(runId, finishCapture);
					const memoryTool = createSubagentMemoryTool();

					const subagentResult = yield* subagent.run(
						{
							cwd: request.cwd,
							runId,
							mode: request.mode,
							model: dreamConfig.subagent,
							memorySnapshot,
							transcriptCandidates,
							nowIso: new Date().toISOString(),
						},
						subagentContext,
						[memoryTool as unknown as ToolDefinition, dreamFinishTool as unknown as ToolDefinition],
						() => Effect.void,
					);

					yield* mem.reloadFrozenSnapshot(request.cwd);

					const finishedAt = yield* Clock.currentTimeMillis;

					const finishParams = finishCapture.value;
					const runResult: DreamRunResult = {
						mode: request.mode,
						startedAt,
						finishedAt,
						summary: finishParams?.summary ?? "Dream run completed",
						reviewedSessions: finishParams?.reviewedSessions ?? [],
						memoryMutations: subagentResult.memoryMutations,
						noChanges: finishParams?.noChanges ?? subagentResult.memoryMutations === 0,
					};

					yield* scheduler.markCompleted(request.cwd, runResult);
					return runResult;
				},
			);

			// ── runOnce with task progress reporting ──────────────────
			function runOnceWithProgress(
				request: DreamRunRequest,
				taskId: string,
			): Effect.Effect<void, never, Scope.Scope> {
				return Effect.gen(function* () {
					const startedAt = yield* Clock.currentTimeMillis;

					const dreamConfig = yield* runtimeConfig.loadConfig(request.cwd).pipe(
						Effect.catch((err: DreamConfigError) => failTask(taskId, err)),
					);

					if (!dreamConfig.enabled) {
						yield* reg.fail(taskId, new DreamDisabled({ mode: request.mode }));
						return;
					}

					// Acquire lock
					yield* progress(taskId, {
						_tag: "PhaseChanged",
						phase: "orient",
						message: "Acquiring lock",
					});

					yield* lock.acquire(request.cwd).pipe(
						Effect.catch((err: DreamLockError) => failTask(taskId, err)),
					);

					// Orient
					yield* progress(taskId, {
						_tag: "PhaseChanged",
						phase: "orient",
						message: "Loading memory snapshot",
					});

					const memorySnapshot = yield* mem.getEntriesSnapshot(request.cwd).pipe(
						Effect.catch((err) => failTask(taskId, err)),
					);

					// Gather
					yield* progress(taskId, {
						_tag: "PhaseChanged",
						phase: "gather",
						message: "Scanning transcripts",
					});

					const lastCompletedAt = yield* scheduler.readLastCompletedAt(request.cwd).pipe(
						Effect.catch((err: DreamLockError) => failTask(taskId, err)),
					);
					const sinceMs = lastCompletedAt ?? 0;

					const transcriptCandidates = yield* scanTranscripts(
						request.cwd,
						sinceMs,
						request.currentSessionId,
					).pipe(
						Effect.catch((err: DreamLockIoError) => failTask(taskId, err)),
					);

					yield* progress(taskId, {
						_tag: "SessionsDiscovered",
						total: transcriptCandidates.length,
					});

					// Run subagent with memory tool and dream_finish
					yield* progress(taskId, {
						_tag: "PhaseChanged",
						phase: "consolidate",
						message: "Running subagent",
					});

					const runId = nanoid(12);
					const finishCapture: DreamFinishCapture = { value: undefined };
					const dreamFinishTool = createDreamFinishToolForSubagent(runId, finishCapture);
					const memoryTool = createSubagentMemoryTool();

					const subagentResult = yield* subagent
						.run(
							{
								cwd: request.cwd,
								runId,
								mode: request.mode,
								model: dreamConfig.subagent,
								memorySnapshot,
								transcriptCandidates,
								nowIso: new Date().toISOString(),
							},
							subagentContext,
							[memoryTool as unknown as ToolDefinition, dreamFinishTool as unknown as ToolDefinition],
							(event: DreamProgressEvent) => progress(taskId, event),
						)
						.pipe(
							Effect.catch((err: DreamSubagentError) => failTask(taskId, err)),
						);

					// Check if dream_finish was called
					if (finishCapture.value === undefined) {
						yield* failTask(
							taskId,
							new DreamSubagentNoFinish({
								reason: "Dream subagent ended without calling dream_finish",
							}),
						);
						return;
					}

					// Reload frozen snapshot
					yield* mem.reloadFrozenSnapshot(request.cwd).pipe(
						Effect.catch((err) => failTask(taskId, err)),
					);

					const finishedAt = yield* Clock.currentTimeMillis;
					const finishParams = finishCapture.value;
					const runResult: DreamRunResult = {
						mode: request.mode,
						startedAt,
						finishedAt,
						summary: finishParams.summary,
						reviewedSessions: finishParams.reviewedSessions,
						memoryMutations: subagentResult.memoryMutations,
						noChanges: finishParams.noChanges,
					};

					// Best-effort scheduler update
					yield* scheduler.markCompleted(request.cwd, runResult).pipe(
						Effect.catch(() => Effect.void),
					);

					yield* reg.complete(taskId, runResult);
				}).pipe(
					// Catch-all for interruption/defects: mark task failed
					Effect.catchCause((cause) =>
						reg
							.fail(
								taskId,
								new DreamLockIoError({
									path: request.cwd,
									operation: "runOnceWithProgress",
									reason: `Unhandled dream failure: ${String(cause)}`,
								}),
							)
							.pipe(Effect.ignore),
					),
				);
			}

			// ── spawnManual ────────────────────────────────────────────
			const spawnManual: DreamRunnerApi["spawnManual"] = Effect.fn("DreamRunner.spawnManual")(
				function* (request) {
					const dreamConfig = yield* runtimeConfig.loadConfig(request.cwd);
					if (!dreamConfig.enabled || !dreamConfig.manual.enabled) {
						return yield* new DreamDisabled({ mode: "manual" });
					}

					// Pre-flight lock check (non-blocking)
					const lockInfo = yield* lock.inspect(request.cwd);
					if (Option.isSome(lockInfo)) {
						return yield* new DreamLockHeld({
							path: lockInfo.value.path,
							holderPid: lockInfo.value.holderPid,
						});
					}

					const handle = yield* reg.create(request);
					const fiber = yield* Effect.forkDetach(
						Effect.scoped(runOnceWithProgress(request, handle.taskId)),
					);
					yield* reg.attach(
						handle.taskId,
						fiber as unknown as import("effect").Fiber.Fiber<DreamRunResult, DreamRunError>,
					);

					return handle;
				},
			);

			// ── maybeSpawnAuto ──────────────────────────────────────────
			const maybeSpawnAuto: DreamRunnerApi["maybeSpawnAuto"] = Effect.fn("DreamRunner.maybeSpawnAuto")(
				function* (request) {
					const permitResult = yield* scheduler.evaluateAutoStart(request).pipe(
						Effect.map(Option.some),
						Effect.catchIf(
							(err: DreamConfigError | DreamGateError | DreamLockError) =>
								err._tag === "DreamDisabled" ||
								err._tag === "DreamTooSoon" ||
								err._tag === "DreamNotEnoughSessions" ||
								err._tag === "DreamSessionScanThrottled" ||
								err._tag === "DreamLockHeld",
							() => Effect.succeed(Option.none()),
						),
					);

					if (Option.isNone(permitResult)) {
						return Option.none();
					}

					const handle = yield* reg.create(request);
					const fiber = yield* Effect.forkDetach(
						Effect.scoped(runOnceWithProgress(request, handle.taskId)),
					);
					yield* reg.attach(
						handle.taskId,
						fiber as unknown as import("effect").Fiber.Fiber<DreamRunResult, DreamRunError>,
					);

					return Option.some(handle);
				},
			);

			return DreamRunner.of({
				runOnce: (request) => Effect.scoped(runOnceScoped(request)),
				spawnManual,
				maybeSpawnAuto,
			});
		}),
	);
