import * as path from "node:path";

import { Effect, FileSystem, Layer, Option, ServiceMap } from "effect";

import {
	decodeAutoresearchPhaseSnapshotJson,
	decodeLoopPersistedStateJson,
	encodeAutoresearchPhaseSnapshotJson,
	encodeLoopPersistedStateJson,
	type AutoresearchPhaseSnapshot,
	type LoopPersistedState,
} from "./schema.js";
import { LoopContractValidationError } from "./errors.js";
import {
	LOOPS_DIR,
	LOOPS_ARCHIVE_PHASES_DIR,
	LOOPS_ARCHIVE_RUNS_DIR,
	LOOPS_ARCHIVE_STATE_DIR,
	LOOPS_ARCHIVE_TASKS_DIR,
	LOOPS_PHASES_DIR,
	LOOPS_RUNS_DIR,
	LOOPS_STATE_DIR,
	LOOPS_TASKS_DIR,
	loopPhaseDirectory,
	loopPhaseFile,
	loopRunDirectory,
	loopRunsDirectory,
	loopStateFile,
	loopTaskFile,
} from "./paths.js";

const isPlatformReasonTag = (error: unknown, tag: string): boolean => {
	if (typeof error !== "object" || error === null) {
		return false;
	}
	if (!("_tag" in error) || error._tag !== "PlatformError") {
		return false;
	}
	if (!("reason" in error) || typeof error.reason !== "object" || error.reason === null) {
		return false;
	}
	return "_tag" in error.reason && error.reason._tag === tag;
};

const isNotFound = (error: unknown): boolean => isPlatformReasonTag(error, "NotFound");

function withFileContext(
	cwd: string,
	filePath: string,
	error: LoopContractValidationError,
): LoopContractValidationError {
	const relativePath = path.relative(cwd, filePath);
	const displayPath = relativePath.length > 0 ? relativePath : filePath;
	return new LoopContractValidationError({
		entity: error.entity,
		reason: `${displayPath}: ${error.reason}`,
	});
}

function loopsRoot(cwd: string): string {
	return path.resolve(cwd, LOOPS_DIR);
}

function resolveTaskPath(cwd: string, taskId: string, archived = false): string {
	return path.resolve(cwd, loopTaskFile(taskId, archived));
}

function resolveStatePath(cwd: string, taskId: string, archived = false): string {
	return path.resolve(cwd, loopStateFile(taskId, archived));
}

function resolvePhaseDirectory(cwd: string, taskId: string, archived = false): string {
	return path.resolve(cwd, loopPhaseDirectory(taskId, archived));
}

function resolvePhasePath(
	cwd: string,
	taskId: string,
	phaseId: string,
	archived = false,
): string {
	return path.resolve(cwd, loopPhaseFile(taskId, phaseId, archived));
}

function resolveRunsDirectory(cwd: string, taskId: string, archived = false): string {
	return path.resolve(cwd, loopRunsDirectory(taskId, archived));
}

function resolveRunDirectory(
	cwd: string,
	taskId: string,
	runId: string,
	archived = false,
): string {
	return path.resolve(cwd, loopRunDirectory(taskId, runId, archived));
}

const ensureParentDirectory = (
	fs: FileSystem.FileSystem,
	filePath: string,
): Effect.Effect<void, never, never> =>
	fs.makeDirectory(path.dirname(filePath), { recursive: true }).pipe(Effect.orDie);

const readOptionalFile = (
	fs: FileSystem.FileSystem,
	filePath: string,
): Effect.Effect<Option.Option<string>, never, never> =>
	fs.readFileString(filePath).pipe(
		Effect.map((content) => Option.some(content)),
		Effect.catchIf(isNotFound, () => Effect.succeed(Option.none())),
		Effect.orDie,
	);

const atomicWriteFileString = (
	fs: FileSystem.FileSystem,
	filePath: string,
	content: string,
): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		yield* ensureParentDirectory(fs, filePath);
		const tempPath = path.join(
			path.dirname(filePath),
			`.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
		);
		yield* fs.writeFileString(tempPath, content).pipe(Effect.orDie);
		yield* fs.rename(tempPath, filePath).pipe(Effect.orDie);
	});

const renameIfExists = (
	fs: FileSystem.FileSystem,
	sourcePath: string,
	destinationPath: string,
): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		const exists = yield* fs.exists(sourcePath).pipe(Effect.orDie);
		if (!exists) {
			return yield* Effect.void;
		}
		yield* ensureParentDirectory(fs, destinationPath);
		yield* fs.rename(sourcePath, destinationPath).pipe(Effect.orDie);
	});

export interface LoopRepoService {
	readonly loadState: (
		cwd: string,
		taskId: string,
		archived?: boolean,
	) => Effect.Effect<Option.Option<LoopPersistedState>, LoopContractValidationError, never>;
	readonly saveState: (
		cwd: string,
		state: LoopPersistedState,
		archived?: boolean,
	) => Effect.Effect<void, LoopContractValidationError, never>;
	readonly listStates: (
		cwd: string,
		archived?: boolean,
	) => Effect.Effect<ReadonlyArray<LoopPersistedState>, LoopContractValidationError, never>;
	readonly readTaskFile: (
		cwd: string,
		taskId: string,
		archived?: boolean,
	) => Effect.Effect<Option.Option<string>, never, never>;
	readonly writeTaskFile: (
		cwd: string,
		taskId: string,
		content: string,
		archived?: boolean,
	) => Effect.Effect<void, never, never>;
	readonly ensureTaskFile: (
		cwd: string,
		taskId: string,
		content: string,
	) => Effect.Effect<boolean, never, never>;
	readonly deleteState: (cwd: string, taskId: string, archived?: boolean) => Effect.Effect<void, never, never>;
	readonly deleteTaskFile: (
		cwd: string,
		taskId: string,
		archived?: boolean,
	) => Effect.Effect<void, never, never>;
	readonly savePhaseSnapshot: (
		cwd: string,
		snapshot: AutoresearchPhaseSnapshot,
		archived?: boolean,
	) => Effect.Effect<void, LoopContractValidationError, never>;
	readonly loadPhaseSnapshot: (
		cwd: string,
		taskId: string,
		phaseId: string,
		archived?: boolean,
	) => Effect.Effect<Option.Option<AutoresearchPhaseSnapshot>, LoopContractValidationError, never>;
	readonly listPhaseSnapshots: (
		cwd: string,
		taskId: string,
		archived?: boolean,
	) => Effect.Effect<ReadonlyArray<AutoresearchPhaseSnapshot>, LoopContractValidationError, never>;
	readonly ensureRunDirectory: (
		cwd: string,
		taskId: string,
		runId: string,
		archived?: boolean,
	) => Effect.Effect<string, never, never>;
	readonly deletePhaseDirectory: (
		cwd: string,
		taskId: string,
		archived?: boolean,
	) => Effect.Effect<void, never, never>;
	readonly deleteRunDirectory: (
		cwd: string,
		taskId: string,
		archived?: boolean,
	) => Effect.Effect<void, never, never>;
	readonly archiveTaskArtifacts: (cwd: string, taskId: string) => Effect.Effect<void, never, never>;
	readonly existsLoopsDirectory: (cwd: string) => Effect.Effect<boolean, never, never>;
	readonly removeLoopsDirectory: (cwd: string) => Effect.Effect<void, never, never>;
}

export class LoopRepo extends ServiceMap.Service<LoopRepo, LoopRepoService>()("LoopRepo") {}

export const LoopRepoLive = Layer.effect(
	LoopRepo,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;

		const ensureLayout = (cwd: string): Effect.Effect<void, never, never> =>
			Effect.gen(function* () {
				yield* fs
					.makeDirectory(path.resolve(cwd, LOOPS_TASKS_DIR), { recursive: true })
					.pipe(Effect.orDie);
				yield* fs
					.makeDirectory(path.resolve(cwd, LOOPS_STATE_DIR), { recursive: true })
					.pipe(Effect.orDie);
				yield* fs
					.makeDirectory(path.resolve(cwd, LOOPS_PHASES_DIR), { recursive: true })
					.pipe(Effect.orDie);
				yield* fs
					.makeDirectory(path.resolve(cwd, LOOPS_RUNS_DIR), { recursive: true })
					.pipe(Effect.orDie);
				yield* fs
					.makeDirectory(path.resolve(cwd, LOOPS_ARCHIVE_TASKS_DIR), { recursive: true })
					.pipe(Effect.orDie);
				yield* fs
					.makeDirectory(path.resolve(cwd, LOOPS_ARCHIVE_STATE_DIR), { recursive: true })
					.pipe(Effect.orDie);
				yield* fs
					.makeDirectory(path.resolve(cwd, LOOPS_ARCHIVE_PHASES_DIR), { recursive: true })
					.pipe(Effect.orDie);
				yield* fs
					.makeDirectory(path.resolve(cwd, LOOPS_ARCHIVE_RUNS_DIR), { recursive: true })
					.pipe(Effect.orDie);
			});

		const loadState: LoopRepoService["loadState"] = Effect.fn("LoopRepo.loadState")(
			function* (cwd, taskId, archived = false) {
				const filePath = resolveStatePath(cwd, taskId, archived);
				const contentOption = yield* readOptionalFile(fs, filePath);
				if (Option.isNone(contentOption)) {
					return Option.none();
				}
				const state = yield* decodeLoopPersistedStateJson(contentOption.value).pipe(
					Effect.mapError((error) => withFileContext(cwd, filePath, error)),
				);
				return Option.some(state);
			},
		);

		const saveState: LoopRepoService["saveState"] = Effect.fn("LoopRepo.saveState")(
			function* (cwd, state, archived = false) {
				yield* ensureLayout(cwd);
				const filePath = resolveStatePath(cwd, state.taskId, archived);
				const encoded = yield* encodeLoopPersistedStateJson(state);
				yield* atomicWriteFileString(fs, filePath, encoded);
			},
		);

		const listStates: LoopRepoService["listStates"] = Effect.fn("LoopRepo.listStates")(
			function* (cwd, archived = false) {
				const dir = path.resolve(cwd, archived ? LOOPS_ARCHIVE_STATE_DIR : LOOPS_STATE_DIR);
				const exists = yield* fs.exists(dir).pipe(Effect.orDie);
				if (!exists) {
					return [];
				}

				const entries = yield* fs.readDirectory(dir).pipe(Effect.orDie);
				const states: LoopPersistedState[] = [];
				for (const entry of [...entries].sort((left, right) => left.localeCompare(right))) {
					if (!entry.endsWith(".json")) {
						continue;
					}
					const filePath = path.join(dir, entry);
					const contentOption = yield* readOptionalFile(fs, filePath);
					if (Option.isNone(contentOption)) {
						continue;
					}
					states.push(
						yield* decodeLoopPersistedStateJson(contentOption.value).pipe(
							Effect.mapError((error) => withFileContext(cwd, filePath, error)),
						),
					);
				}

				return states;
			},
		);

		const readTaskFile: LoopRepoService["readTaskFile"] = Effect.fn("LoopRepo.readTaskFile")(
			function* (cwd, taskId, archived = false) {
				return yield* readOptionalFile(fs, resolveTaskPath(cwd, taskId, archived));
			},
		);

		const writeTaskFile: LoopRepoService["writeTaskFile"] = Effect.fn("LoopRepo.writeTaskFile")(
			function* (cwd, taskId, content, archived = false) {
				yield* ensureLayout(cwd);
				yield* atomicWriteFileString(fs, resolveTaskPath(cwd, taskId, archived), content);
			},
		);

		const ensureTaskFile: LoopRepoService["ensureTaskFile"] = Effect.fn("LoopRepo.ensureTaskFile")(
			function* (cwd, taskId, content) {
				yield* ensureLayout(cwd);
				const taskPath = resolveTaskPath(cwd, taskId, false);
				const exists = yield* fs.exists(taskPath).pipe(Effect.orDie);
				if (exists) {
					return false;
				}
				yield* atomicWriteFileString(fs, taskPath, content);
				return true;
			},
		);

		const deleteState: LoopRepoService["deleteState"] = Effect.fn("LoopRepo.deleteState")(
			function* (cwd, taskId, archived = false) {
				yield* fs.remove(resolveStatePath(cwd, taskId, archived), { force: true }).pipe(
					Effect.orDie,
				);
			},
		);

		const deleteTaskFile: LoopRepoService["deleteTaskFile"] = Effect.fn("LoopRepo.deleteTaskFile")(
			function* (cwd, taskId, archived = false) {
				yield* fs.remove(resolveTaskPath(cwd, taskId, archived), { force: true }).pipe(
					Effect.orDie,
				);
			},
		);

		const savePhaseSnapshot: LoopRepoService["savePhaseSnapshot"] = Effect.fn(
			"LoopRepo.savePhaseSnapshot",
		)(function* (cwd, snapshot, archived = false) {
			yield* ensureLayout(cwd);
			const filePath = resolvePhasePath(cwd, snapshot.taskId, snapshot.phaseId, archived);
			const encoded = yield* encodeAutoresearchPhaseSnapshotJson(snapshot);
			yield* atomicWriteFileString(fs, filePath, encoded);
		});

		const loadPhaseSnapshot: LoopRepoService["loadPhaseSnapshot"] = Effect.fn(
			"LoopRepo.loadPhaseSnapshot",
		)(function* (cwd, taskId, phaseId, archived = false) {
			const filePath = resolvePhasePath(cwd, taskId, phaseId, archived);
			const contentOption = yield* readOptionalFile(fs, filePath);
			if (Option.isNone(contentOption)) {
				return Option.none();
			}
			const snapshot = yield* decodeAutoresearchPhaseSnapshotJson(contentOption.value).pipe(
				Effect.mapError((error) => withFileContext(cwd, filePath, error)),
			);
			return Option.some(snapshot);
		});

		const listPhaseSnapshots: LoopRepoService["listPhaseSnapshots"] = Effect.fn(
			"LoopRepo.listPhaseSnapshots",
		)(function* (cwd, taskId, archived = false) {
			const dir = resolvePhaseDirectory(cwd, taskId, archived);
			const exists = yield* fs.exists(dir).pipe(Effect.orDie);
			if (!exists) {
				return [];
			}

			const entries = yield* fs.readDirectory(dir).pipe(Effect.orDie);
			const snapshots: AutoresearchPhaseSnapshot[] = [];
			for (const entry of [...entries].sort((left, right) => left.localeCompare(right))) {
				if (!entry.endsWith(".json")) {
					continue;
				}
				const filePath = path.join(dir, entry);
				const contentOption = yield* readOptionalFile(fs, filePath);
				if (Option.isNone(contentOption)) {
					continue;
				}
				snapshots.push(
					yield* decodeAutoresearchPhaseSnapshotJson(contentOption.value).pipe(
						Effect.mapError((error) => withFileContext(cwd, filePath, error)),
					),
				);
			}

			return snapshots;
		});

		const ensureRunDirectory: LoopRepoService["ensureRunDirectory"] = Effect.fn(
			"LoopRepo.ensureRunDirectory",
		)(function* (cwd, taskId, runId, archived = false) {
			yield* ensureLayout(cwd);
			const runDir = resolveRunDirectory(cwd, taskId, runId, archived);
			yield* fs.makeDirectory(runDir, { recursive: true }).pipe(Effect.orDie);
			return runDir;
		});

		const deletePhaseDirectory: LoopRepoService["deletePhaseDirectory"] = Effect.fn(
			"LoopRepo.deletePhaseDirectory",
		)(function* (cwd, taskId, archived = false) {
			yield* fs
				.remove(resolvePhaseDirectory(cwd, taskId, archived), { recursive: true, force: true })
				.pipe(Effect.orDie);
		});

		const deleteRunDirectory: LoopRepoService["deleteRunDirectory"] = Effect.fn(
			"LoopRepo.deleteRunDirectory",
		)(function* (cwd, taskId, archived = false) {
			yield* fs
				.remove(resolveRunsDirectory(cwd, taskId, archived), { recursive: true, force: true })
				.pipe(Effect.orDie);
		});

		const archiveTaskArtifacts: LoopRepoService["archiveTaskArtifacts"] = Effect.fn(
			"LoopRepo.archiveTaskArtifacts",
		)(function* (cwd, taskId) {
			yield* ensureLayout(cwd);

			yield* renameIfExists(
				fs,
				resolveTaskPath(cwd, taskId, false),
				resolveTaskPath(cwd, taskId, true),
			);
			yield* renameIfExists(
				fs,
				resolvePhaseDirectory(cwd, taskId, false),
				resolvePhaseDirectory(cwd, taskId, true),
			);
			yield* renameIfExists(
				fs,
				resolveRunsDirectory(cwd, taskId, false),
				resolveRunsDirectory(cwd, taskId, true),
			);
		});

		const existsLoopsDirectory: LoopRepoService["existsLoopsDirectory"] = Effect.fn(
			"LoopRepo.existsLoopsDirectory",
		)(function* (cwd) {
			return yield* fs.exists(loopsRoot(cwd)).pipe(Effect.orDie);
		});

		const removeLoopsDirectory: LoopRepoService["removeLoopsDirectory"] = Effect.fn(
			"LoopRepo.removeLoopsDirectory",
		)(function* (cwd) {
			yield* fs.remove(loopsRoot(cwd), { recursive: true, force: true }).pipe(Effect.orDie);
		});

		return LoopRepo.of({
			loadState,
			saveState,
			listStates,
			readTaskFile,
			writeTaskFile,
			ensureTaskFile,
			deleteState,
			deleteTaskFile,
			savePhaseSnapshot,
			loadPhaseSnapshot,
			listPhaseSnapshots,
			ensureRunDirectory,
			deletePhaseDirectory,
			deleteRunDirectory,
			archiveTaskArtifacts,
			existsLoopsDirectory,
			removeLoopsDirectory,
		});
	}),
);
