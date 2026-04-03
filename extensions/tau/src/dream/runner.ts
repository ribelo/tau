// DreamRunner -- orchestration service that coordinates lock, scheduler,
// subagent, and task registry to execute memory consolidation runs.
// The subagent proposes; DreamRunner applies.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Dirent, Stats } from "node:fs";

import { Clock, Effect, Layer, Option, Scope, ServiceMap } from "effect";

import type { ModelRegistry } from "@mariozechner/pi-coding-agent";

import type {
	DreamMutation,
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
import { DreamDisabled, DreamLockHeld, DreamLockIoError } from "./errors.js";
import type { DreamRunError } from "./task-registry.js";

import { DreamLock } from "./lock.js";
import { DreamScheduler } from "./scheduler.js";
import { DreamTaskRegistry } from "./task-registry.js";
import { DreamSubagent, type DreamSubagentContext } from "./subagent.js";
import {
	dreamTranscriptRoot,
	isDreamTranscriptFile,
	parseDreamTranscriptSessionId,
} from "./transcripts.js";
import { CuratedMemory, type MutationResult } from "../services/curated-memory.js";
import type { MemoryFileError, MemoryMutationError } from "../memory/errors.js";

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
// Transcript candidate selection
// ---------------------------------------------------------------------------

/** Reserve 2 turns for orient+response; rest are available for file reads. */
function deriveTranscriptReviewLimit(maxTurns: number): number {
	return Math.max(1, maxTurns - 2);
}

function selectTranscriptCandidates(
	candidates: ReadonlyArray<DreamTranscriptCandidate>,
	maxTurns: number,
): ReadonlyArray<DreamTranscriptCandidate> {
	const limit = deriveTranscriptReviewLimit(maxTurns);
	return candidates.slice(0, limit);
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

			const subagentContext: DreamSubagentContext = {
				modelRegistry: runtimeConfig.modelRegistry,
			};

			// ── helpers (capture resolved services) ────────────────────

			function applyOp(
				op: DreamMutation,
				cwd: string,
			): Effect.Effect<MutationResult, MemoryMutationError> {
				switch (op._tag) {
					case "add":
						return mem.add(op.scope, op.content, cwd);
					case "update":
						return mem.update(op.scope, op.id, op.content, cwd);
					case "remove":
						return mem.remove(op.scope, op.id, cwd);
				}
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
					const allCandidates = yield* scanTranscripts(
						request.cwd,
						sinceMs,
						request.currentSessionId,
					);
					const transcriptCandidates = selectTranscriptCandidates(
						allCandidates,
						dreamConfig.subagent.maxTurns,
					);

					const nowIso = new Date().toISOString();
					const plan = yield* subagent.plan(
						{
							cwd: request.cwd,
							mode: request.mode,
							model: dreamConfig.subagent,
							memorySnapshot,
							transcriptCandidates,
							nowIso,
						},
						subagentContext,
						() => Effect.void,
					);

					const applied: MutationResult[] = [];
					for (const op of plan.operations) {
						const result = yield* applyOp(op, request.cwd).pipe(
							Effect.map(Option.some),
							Effect.catchIf(
								(err: MemoryMutationError) =>
									request.mode === "auto" &&
									(err._tag === "MemoryDuplicateEntry" || err._tag === "MemoryNoMatch"),
								() => Effect.succeed(Option.none<MutationResult>()),
							),
						);
						if (Option.isSome(result)) {
							applied.push(result.value);
						}
					}

					yield* mem.reloadFrozenSnapshot(request.cwd);

					const finishedAt = yield* Clock.currentTimeMillis;
					const runResult: DreamRunResult = {
						mode: request.mode,
						startedAt,
						finishedAt,
						reviewedSessions: transcriptCandidates,
						plan,
						applied,
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
					const _startedAt = yield* Clock.currentTimeMillis;

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
						Effect.catch((err: MemoryFileError) => failTask(taskId, err)),
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

					const allCandidates = yield* scanTranscripts(
						request.cwd,
						sinceMs,
						request.currentSessionId,
					).pipe(
						Effect.catch((err: DreamLockIoError) => failTask(taskId, err)),
					);
					const transcriptCandidates = selectTranscriptCandidates(
						allCandidates,
						dreamConfig.subagent.maxTurns,
					);

					yield* progress(taskId, {
						_tag: "SessionsDiscovered",
						total: allCandidates.length,
					});

					if (transcriptCandidates.length < allCandidates.length) {
						yield* progress(taskId, {
							_tag: "Note",
							text: `Reviewing ${transcriptCandidates.length} of ${allCandidates.length} most recent sessions (maxTurns=${dreamConfig.subagent.maxTurns})`,
						});
					}

					// Consolidate
					yield* progress(taskId, {
						_tag: "PhaseChanged",
						phase: "consolidate",
						message: "Running subagent",
					});

					const plan = yield* subagent
						.plan(
							{
								cwd: request.cwd,
								mode: request.mode,
								model: dreamConfig.subagent,
								memorySnapshot,
								transcriptCandidates,
								nowIso: new Date().toISOString(),
							},
							subagentContext,
							(event: DreamProgressEvent) => progress(taskId, event),
						)
						.pipe(
							Effect.catch((err: DreamSubagentError) => failTask(taskId, err)),
						);

					yield* progress(taskId, {
						_tag: "OperationsPlanned",
						total: plan.operations.length,
					});

					// Apply
					yield* progress(taskId, {
						_tag: "PhaseChanged",
						phase: "apply",
						message: "Applying memory mutations",
					});

					const applied: MutationResult[] = [];
					for (let i = 0; i < plan.operations.length; i++) {
						const op = plan.operations[i]!;
						const result = yield* applyOp(op, request.cwd).pipe(
							Effect.map(Option.some),
							Effect.catchIf(
								(err: MemoryMutationError) =>
									request.mode === "auto" &&
									(err._tag === "MemoryDuplicateEntry" || err._tag === "MemoryNoMatch"),
								() => Effect.succeed(Option.none<MutationResult>()),
							),
							Effect.catch((err: MemoryMutationError) => failTask(taskId, err)),
						);

						if (Option.isSome(result)) {
							applied.push(result.value);
						}

						yield* progress(taskId, {
							_tag: "OperationApplied",
							applied: applied.length,
							total: plan.operations.length,
							summary: `${op._tag} ${op.scope}${op._tag !== "add" ? ` [${op.id}]` : ""}`,
						});
					}

					// Reload frozen snapshot
					yield* mem.reloadFrozenSnapshot(request.cwd).pipe(
						Effect.catch((err: MemoryFileError) => failTask(taskId, err)),
					);

					const finishedAt = yield* Clock.currentTimeMillis;
					const runResult: DreamRunResult = {
						mode: request.mode,
						startedAt: _startedAt,
						finishedAt,
						reviewedSessions: transcriptCandidates,
						plan,
						applied,
					};

					// Best-effort scheduler update
					yield* scheduler.markCompleted(request.cwd, runResult).pipe(
						Effect.catch(() => Effect.void),
					);

					yield* reg.complete(taskId, runResult);
				}).pipe(
					// Catch-all for interruption/defects: mark task failed
					Effect.catchCause(() =>
						reg.fail(taskId, new DreamDisabled({ mode: request.mode })).pipe(
							Effect.ignore,
						),
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
					// Fiber is only used for interruption; type-cast is safe
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

export { deriveTranscriptReviewLimit as _deriveTranscriptReviewLimit };
export { selectTranscriptCandidates as _selectDreamTranscriptCandidates };
