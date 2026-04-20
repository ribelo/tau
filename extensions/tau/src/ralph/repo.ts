import * as fs from "node:fs";
import * as path from "node:path";

import { Effect, FileSystem, Layer, Option, ServiceMap } from "effect";

import { LoopRepo, LoopRepoLive } from "../loops/repo.js";
import type {
	LoopPersistedState,
	LoopSessionRef,
	RalphLoopPersistedState,
} from "../loops/schema.js";
import {
	RALPH_ARCHIVE_TASKS_DIR,
	RALPH_DIR,
} from "./paths.js";
import { RalphContractValidationError } from "./errors.js";
import type { LoopState } from "./schema.js";

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

const optionContains = (option: Option.Option<string>, value: string | undefined): boolean => {
	if (value === undefined) {
		return false;
	}
	return Option.match(option, {
		onNone: () => false,
		onSome: (optionValue) => optionValue === value,
	});
};

const nowIso = Effect.sync(() => new Date().toISOString());

const LEGACY_LAYOUT_MESSAGE =
	"Legacy Ralph layout detected under .pi/ralph. Import or remove old flat files, then retry.";

function toContractError(entity: string, reason: string): RalphContractValidationError {
	return new RalphContractValidationError({
		entity,
		reason,
	});
}

function makeLegacyLayoutError(): RalphContractValidationError {
	return toContractError("ralph.legacy_layout", LEGACY_LAYOUT_MESSAGE);
}

async function hasFlatFilesInDir(dir: string): Promise<boolean> {
	try {
		const entries = await fs.promises.readdir(dir);
		for (const entry of entries) {
			if (entry.endsWith(".state.json") || entry.endsWith(".md")) {
				return true;
			}
		}
	} catch {
		// Directory does not exist.
	}
	return false;
}

const detectLegacyLayout = (cwd: string): Effect.Effect<boolean, never, never> =>
	Effect.promise(async () => {
		const root = path.resolve(cwd, ".pi", "ralph");
		const archive = path.join(root, "archive");
		return (await hasFlatFilesInDir(root)) || (await hasFlatFilesInDir(archive));
	});

function lifecycleToStatus(
	lifecycle: LoopPersistedState["lifecycle"],
): LoopState["status"] {
	switch (lifecycle) {
		case "active":
			return "active";
		case "paused":
		case "draft":
			return "paused";
		case "completed":
		case "archived":
			return "completed";
	}
}

function statusToLifecycle(status: LoopState["status"]): RalphLoopPersistedState["lifecycle"] {
	switch (status) {
		case "active":
			return "active";
		case "paused":
			return "paused";
		case "completed":
			return "completed";
	}
}

function ownershipFile(option: Option.Option<LoopSessionRef>): Option.Option<string> {
	return Option.map(option, (session) => session.sessionFile);
}

function normalizeSessionRef(
	existing: Option.Option<LoopSessionRef>,
	sessionFile: Option.Option<string>,
): Option.Option<LoopSessionRef> {
	return Option.match(sessionFile, {
		onNone: () => Option.none(),
		onSome: (file) =>
			Option.match(existing, {
				onNone: () =>
					Option.some({
						sessionId: file,
						sessionFile: file,
					}),
				onSome: (current) =>
					current.sessionFile === file
						? Option.some(current)
						: Option.some({
							sessionId: file,
							sessionFile: file,
						}),
			}),
	});
}

function toLoopState(state: RalphLoopPersistedState): LoopState {
	return {
		name: state.taskId,
		taskFile: state.taskFile,
		iteration: state.ralph.iteration,
		maxIterations: state.ralph.maxIterations,
		itemsPerIteration: state.ralph.itemsPerIteration,
		reflectEvery: state.ralph.reflectEvery,
		reflectInstructions: state.ralph.reflectInstructions,
		status: lifecycleToStatus(state.lifecycle),
		executionProfile: state.ralph.pinnedExecutionProfile,
		startedAt: Option.getOrElse(state.startedAt, () => state.createdAt),
		lastReflectionAt: state.ralph.lastReflectionAt,
		completedAt: state.completedAt,
		controllerSessionFile: ownershipFile(state.ownership.controller),
		activeIterationSessionFile: ownershipFile(state.ownership.child),
		pendingDecision: state.ralph.pendingDecision,
	};
}

function ensureRalphState(
	state: LoopPersistedState,
	entity: string,
): Effect.Effect<RalphLoopPersistedState, RalphContractValidationError, never> {
	if (state.kind === "ralph") {
		return Effect.succeed(state);
	}
	return Effect.fail(
		toContractError(
			entity,
			`task "${state.taskId}" is kind "${state.kind}", expected "ralph"`,
		),
	);
}

function isRalphOwnedState(state: LoopPersistedState): boolean {
	return (
		state.kind === "ralph" ||
		(state.kind === "blocked_manual_resolution" && state.previousKind === "ralph")
	);
}

export function loopOwnsSessionFile(loop: LoopState, sessionFile: string | undefined): boolean {
	return (
		optionContains(loop.controllerSessionFile, sessionFile) ||
		optionContains(loop.activeIterationSessionFile, sessionFile)
	);
}

export function ralphDir(cwd: string): string {
	return path.resolve(cwd, RALPH_DIR);
}

const readOptionalFile = (
	fs: FileSystem.FileSystem,
	filePath: string,
): Effect.Effect<Option.Option<string>, never, never> =>
	fs.readFileString(filePath).pipe(
		Effect.map((content) => Option.some(content)),
		Effect.catchIf(isNotFound, () => Effect.succeed(Option.none())),
		Effect.orDie,
	);

const ensureParentDirectory = (
	fs: FileSystem.FileSystem,
	filePath: string,
): Effect.Effect<void, never, never> =>
	fs.makeDirectory(path.dirname(filePath), { recursive: true }).pipe(Effect.orDie);

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

function toPersistedState(
	state: LoopState,
	existing: Option.Option<RalphLoopPersistedState>,
	archived: boolean,
	timestamp: string,
): RalphLoopPersistedState {
	const existingValue = Option.getOrUndefined(existing);
	const lifecycle = archived ? "archived" : statusToLifecycle(state.status);

	return {
		taskId: state.name,
		title: existingValue?.title ?? state.name,
		taskFile: state.taskFile,
		kind: "ralph",
		lifecycle,
		createdAt: existingValue?.createdAt ?? state.startedAt,
		updatedAt: timestamp,
		startedAt: Option.some(state.startedAt),
		completedAt: state.completedAt,
		archivedAt:
			lifecycle === "archived"
				? Option.some(timestamp)
				: existingValue?.archivedAt ?? Option.none(),
		ownership: {
			controller: normalizeSessionRef(
				existingValue?.ownership.controller ?? Option.none(),
				state.controllerSessionFile,
			),
			child: normalizeSessionRef(
				existingValue?.ownership.child ?? Option.none(),
				state.activeIterationSessionFile,
			),
		},
		ralph: {
			iteration: state.iteration,
			maxIterations: state.maxIterations,
			itemsPerIteration: state.itemsPerIteration,
			reflectEvery: state.reflectEvery,
			reflectInstructions: state.reflectInstructions,
			lastReflectionAt: state.lastReflectionAt,
			pendingDecision: state.pendingDecision,
			pinnedExecutionProfile: state.executionProfile,
		},
	};
}

export interface RalphRepoService {
	readonly loadState: (
		cwd: string,
		name: string,
		archived?: boolean,
	) => Effect.Effect<Option.Option<LoopState>, RalphContractValidationError, never>;
	readonly saveState: (
		cwd: string,
		state: LoopState,
		archived?: boolean,
	) => Effect.Effect<void, RalphContractValidationError, never>;
	readonly listLoops: (
		cwd: string,
		archived?: boolean,
	) => Effect.Effect<ReadonlyArray<LoopState>, RalphContractValidationError, never>;
	readonly findLoopBySessionFile: (
		cwd: string,
		sessionFile: string | undefined,
	) => Effect.Effect<Option.Option<LoopState>, RalphContractValidationError, never>;
	readonly readTaskFile: (
		cwd: string,
		taskFile: string,
	) => Effect.Effect<Option.Option<string>, never, never>;
	readonly writeTaskFile: (
		cwd: string,
		taskFile: string,
		content: string,
	) => Effect.Effect<void, never, never>;
	readonly ensureTaskFile: (
		cwd: string,
		taskFile: string,
		content: string,
	) => Effect.Effect<boolean, never, never>;
	readonly deleteState: (cwd: string, name: string, archived?: boolean) => Effect.Effect<void, never, never>;
	readonly deleteTaskByLoopName: (
		cwd: string,
		name: string,
		archived?: boolean,
	) => Effect.Effect<void, never, never>;
	readonly archiveLoop: (cwd: string, state: LoopState) => Effect.Effect<void, never, never>;
	readonly existsRalphDirectory: (cwd: string) => Effect.Effect<boolean, never, never>;
	readonly removeRalphDirectory: (cwd: string) => Effect.Effect<void, never, never>;
}

export class RalphRepo extends ServiceMap.Service<RalphRepo, RalphRepoService>()("RalphRepo") {}

const RalphRepoBase = Layer.effect(
	RalphRepo,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const loopRepo = yield* LoopRepo;

		const loadState: RalphRepoService["loadState"] = Effect.fn("RalphRepo.loadState")(
			function* (cwd, name, archived = false) {
				if (yield* detectLegacyLayout(cwd)) {
					return yield* Effect.fail(makeLegacyLayoutError());
				}
				const persisted = yield* loopRepo.loadState(cwd, name, archived).pipe(
					Effect.mapError((error) =>
						toContractError(error.entity, error.reason),
					),
				);
				if (Option.isNone(persisted)) {
					return Option.none();
				}
				const ralphState = yield* ensureRalphState(persisted.value, "ralph.loop_state");
				return Option.some(toLoopState(ralphState));
			},
		);

		const saveState: RalphRepoService["saveState"] = Effect.fn("RalphRepo.saveState")(
			function* (cwd, state, archived = false) {
				const existing = yield* loopRepo.loadState(cwd, state.name, archived).pipe(
					Effect.mapError((error) =>
						toContractError(error.entity, error.reason),
					),
				);
				const existingRalph = Option.isSome(existing)
					? Option.some(yield* ensureRalphState(existing.value, "ralph.loop_state"))
					: Option.none<RalphLoopPersistedState>();
				const timestamp = yield* nowIso;
				const nextState = toPersistedState(state, existingRalph, archived, timestamp);
				yield* loopRepo.saveState(cwd, nextState, archived).pipe(
					Effect.mapError((error) =>
						toContractError(error.entity, error.reason),
					),
				);
			},
		);

		const listLoops: RalphRepoService["listLoops"] = Effect.fn("RalphRepo.listLoops")(
			function* (cwd, archived = false) {
				if (yield* detectLegacyLayout(cwd)) {
					return yield* Effect.fail(makeLegacyLayoutError());
				}
				const persisted = yield* loopRepo.listStates(cwd, archived).pipe(
					Effect.mapError((error) =>
						toContractError(error.entity, error.reason),
					),
				);
				const loops: LoopState[] = [];
				for (const state of persisted) {
					if (state.kind !== "ralph") {
						continue;
					}
					loops.push(toLoopState(state));
				}
				return loops;
			},
		);

		const findLoopBySessionFile: RalphRepoService["findLoopBySessionFile"] = Effect.fn(
			"RalphRepo.findLoopBySessionFile",
		)(function* (cwd, sessionFile) {
			if (sessionFile === undefined) {
				return Option.none();
			}

			const loops = yield* listLoops(cwd, false);
			const candidates = loops.filter(
				(loop) => loop.status !== "completed" && loopOwnsSessionFile(loop, sessionFile),
			);
			if (candidates.length === 0) {
				return Option.none();
			}

			const active = candidates.filter((loop) => loop.status === "active");
			if (active.length === 1) {
				const onlyActive = active[0];
				return onlyActive === undefined ? Option.none() : Option.some(onlyActive);
			}

			const paused = candidates.filter((loop) => loop.status === "paused");
			if (active.length === 0 && paused.length === 1) {
				const onlyPaused = paused[0];
				return onlyPaused === undefined ? Option.none() : Option.some(onlyPaused);
			}

			return Option.none();
		});

		const readTaskFile: RalphRepoService["readTaskFile"] = Effect.fn("RalphRepo.readTaskFile")(
			function* (cwd, taskFile) {
				return yield* readOptionalFile(fs, path.resolve(cwd, taskFile));
			},
		);

		const writeTaskFile: RalphRepoService["writeTaskFile"] = Effect.fn("RalphRepo.writeTaskFile")(
			function* (cwd, taskFile, content) {
				yield* atomicWriteFileString(fs, path.resolve(cwd, taskFile), content);
			},
		);

		const ensureTaskFile: RalphRepoService["ensureTaskFile"] = Effect.fn("RalphRepo.ensureTaskFile")(
			function* (cwd, taskFile, content) {
				const target = path.resolve(cwd, taskFile);
				const exists = yield* fs.exists(target).pipe(Effect.orDie);
				if (exists) {
					return false;
				}
				yield* atomicWriteFileString(fs, target, content);
				return true;
			},
		);

		const deleteState: RalphRepoService["deleteState"] = Effect.fn("RalphRepo.deleteState")(
			function* (cwd, name, archived = false) {
				yield* loopRepo.deleteState(cwd, name, archived);
			},
		);

		const deleteTaskByLoopName: RalphRepoService["deleteTaskByLoopName"] = Effect.fn(
			"RalphRepo.deleteTaskByLoopName",
		)(function* (cwd, name, archived = false) {
			yield* loopRepo.deleteTaskFile(cwd, name, archived);
		});

		const archiveLoop: RalphRepoService["archiveLoop"] = Effect.fn("RalphRepo.archiveLoop")(
			function* (cwd, state) {
				const persisted = yield* loopRepo.loadState(cwd, state.name, false).pipe(
					Effect.mapError((error) =>
						toContractError(error.entity, error.reason),
					),
					Effect.orDie,
				);
				if (Option.isNone(persisted) || persisted.value.kind !== "ralph") {
					return yield* Effect.void;
				}

				const timestamp = yield* nowIso;
				const archivedState: RalphLoopPersistedState = {
					...persisted.value,
					taskFile: path.join(RALPH_ARCHIVE_TASKS_DIR, `${persisted.value.taskId}.md`),
					lifecycle: "archived",
					updatedAt: timestamp,
					archivedAt: Option.some(timestamp),
					ownership: {
						controller: Option.none(),
						child: Option.none(),
					},
					ralph: {
						...persisted.value.ralph,
						pendingDecision: Option.none(),
					},
				};

				yield* loopRepo.archiveTaskArtifacts(cwd, persisted.value.taskId);
				yield* loopRepo.saveState(cwd, archivedState, true).pipe(
					Effect.mapError((error) =>
						toContractError(error.entity, error.reason),
					),
					Effect.orDie,
				);
				yield* loopRepo.deleteState(cwd, persisted.value.taskId, false);
			},
		);

		const existsRalphDirectory: RalphRepoService["existsRalphDirectory"] = Effect.fn(
			"RalphRepo.existsRalphDirectory",
		)(function* (cwd) {
			return yield* fs.exists(ralphDir(cwd)).pipe(Effect.orDie);
		});

		const removeRalphDirectory: RalphRepoService["removeRalphDirectory"] = Effect.fn(
			"RalphRepo.removeRalphDirectory",
		)(function* (cwd) {
			const active = yield* loopRepo.listStates(cwd, false).pipe(
				Effect.mapError((error) =>
					toContractError(error.entity, error.reason),
				),
				Effect.orDie,
			);
			for (const state of active) {
				if (!isRalphOwnedState(state)) {
					continue;
				}
				yield* loopRepo.deleteState(cwd, state.taskId, false);
				yield* loopRepo.deleteTaskFile(cwd, state.taskId, false);
				yield* loopRepo.deletePhaseDirectory(cwd, state.taskId, false);
				yield* loopRepo.deleteRunDirectory(cwd, state.taskId, false);
			}

			const archived = yield* loopRepo.listStates(cwd, true).pipe(
				Effect.mapError((error) =>
					toContractError(error.entity, error.reason),
				),
				Effect.orDie,
			);
			for (const state of archived) {
				if (!isRalphOwnedState(state)) {
					continue;
				}
				yield* loopRepo.deleteState(cwd, state.taskId, true);
				yield* loopRepo.deleteTaskFile(cwd, state.taskId, true);
				yield* loopRepo.deletePhaseDirectory(cwd, state.taskId, true);
				yield* loopRepo.deleteRunDirectory(cwd, state.taskId, true);
			}

			yield* fs
				.remove(path.resolve(cwd, ".pi", "ralph"), {
					recursive: true,
					force: true,
				})
				.pipe(Effect.orDie);
		});

		return RalphRepo.of({
			loadState,
			saveState,
			listLoops,
			findLoopBySessionFile,
			readTaskFile,
			writeTaskFile,
			ensureTaskFile,
			deleteState,
			deleteTaskByLoopName,
			archiveLoop,
			existsRalphDirectory,
			removeRalphDirectory,
		});
	}),
);

export const RalphRepoLive = RalphRepoBase.pipe(Layer.provideMerge(LoopRepoLive));
