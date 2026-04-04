import * as fs from "node:fs";
import * as path from "node:path";

import { Effect, FileSystem, Layer, Option, ServiceMap } from "effect";

import {
	decodeLoopStateJson,
	encodeLoopStateJson,
	type LoopState,
} from "./schema.js";
import { RalphContractValidationError } from "./errors.js";
import {
	RALPH_DIR,
	RALPH_TASKS_DIR,
	RALPH_STATE_DIR,
	RALPH_ARCHIVE_DIR,
	RALPH_ARCHIVE_TASKS_DIR,
	RALPH_ARCHIVE_STATE_DIR,
} from "./paths.js";

const LOOP_STATE_EXT = ".state.json";
const LOOP_TASK_EXT = ".md";

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

export function loopOwnsSessionFile(loop: LoopState, sessionFile: string | undefined): boolean {
	return (
		optionContains(loop.controllerSessionFile, sessionFile) ||
		optionContains(loop.activeIterationSessionFile, sessionFile)
	);
}

export function ralphDir(cwd: string): string {
	return path.resolve(cwd, RALPH_DIR);
}

function isPathInside(parentDir: string, candidatePath: string): boolean {
	const relative = path.relative(parentDir, candidatePath);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function getStatePath(cwd: string, name: string, archived = false): string {
	return archived
		? path.join(path.resolve(cwd, RALPH_ARCHIVE_STATE_DIR), `${name}${LOOP_STATE_EXT}`)
		: path.join(path.resolve(cwd, RALPH_STATE_DIR), `${name}${LOOP_STATE_EXT}`);
}

function getTaskPath(cwd: string, name: string, archived = false): string {
	return archived
		? path.join(path.resolve(cwd, RALPH_ARCHIVE_TASKS_DIR), `${name}${LOOP_TASK_EXT}`)
		: path.join(path.resolve(cwd, RALPH_TASKS_DIR), `${name}${LOOP_TASK_EXT}`);
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

function makeLegacyLayoutError(): RalphContractValidationError {
	return new RalphContractValidationError({
		reason:
			"Legacy Ralph layout detected under .pi/ralph. Please archive or remove old flat files (e.g., run `/ralph nuke --yes`), then restart.",
		entity: "ralph.legacy_layout",
	});
}

async function hasFlatFilesInDir(dir: string): Promise<boolean> {
	try {
		const entries = await fs.promises.readdir(dir);
		for (const entry of entries) {
			if (entry.endsWith(LOOP_STATE_EXT) || entry.endsWith(LOOP_TASK_EXT)) {
				return true;
			}
		}
	} catch {
		// Directory does not exist or is unreadable
	}
	return false;
}

async function detectLegacyLayout(cwd: string): Promise<boolean> {
	const root = ralphDir(cwd);
	const archiveRoot = path.join(root, "archive");
	return (await hasFlatFilesInDir(root)) || (await hasFlatFilesInDir(archiveRoot));
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

export const RalphRepoLive = Layer.effect(
	RalphRepo,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;

		const loadState: RalphRepoService["loadState"] = Effect.fn("RalphRepo.loadState")(
			function* (cwd, name, archived = false) {
				if (yield* Effect.promise(() => detectLegacyLayout(cwd))) {
					return yield* Effect.fail(makeLegacyLayoutError());
				}
				if (!archived) {
					yield* ensureRalphProtectedDirs(cwd);
				}
				const filePath = getStatePath(cwd, name, archived);
				const contentOption = yield* readOptionalFile(fs, filePath);
				if (Option.isNone(contentOption)) {
					return Option.none();
				}
				const state = yield* decodeLoopStateJson(contentOption.value);
				return Option.some(state);
			},
		);

		const saveState: RalphRepoService["saveState"] = Effect.fn("RalphRepo.saveState")(
			function* (cwd, state, archived = false) {
				const filePath = getStatePath(cwd, state.name, archived);
				const encoded = yield* encodeLoopStateJson(state);
				yield* atomicWriteFileString(fs, filePath, encoded);
			},
		);

		const listLoops: RalphRepoService["listLoops"] = Effect.fn("RalphRepo.listLoops")(
			function* (cwd, archived = false) {
				if (yield* Effect.promise(() => detectLegacyLayout(cwd))) {
					return yield* Effect.fail(makeLegacyLayoutError());
				}
				if (!archived) {
					yield* ensureRalphProtectedDirs(cwd);
				}

				const dir = archived
					? path.resolve(cwd, RALPH_ARCHIVE_STATE_DIR)
					: path.resolve(cwd, RALPH_STATE_DIR);
				const exists = yield* fs.exists(dir).pipe(Effect.orDie);
				if (!exists) {
					return [];
				}

				const entries = yield* fs.readDirectory(dir).pipe(Effect.orDie);
				const loops: LoopState[] = [];
				for (const entry of [...entries].sort((left, right) => left.localeCompare(right))) {
					if (!entry.endsWith(LOOP_STATE_EXT)) {
						continue;
					}
					const contentOption = yield* readOptionalFile(fs, path.join(dir, entry));
					if (Option.isNone(contentOption)) {
						continue;
					}
					loops.push(yield* decodeLoopStateJson(contentOption.value));
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
			const found = loops.find(
				(loop) => loop.status === "active" && loopOwnsSessionFile(loop, sessionFile),
			);
			return found === undefined ? Option.none() : Option.some(found);
		});

		const readTaskFile: RalphRepoService["readTaskFile"] = Effect.fn("RalphRepo.readTaskFile")(
			function* (cwd, taskFile) {
				return yield* readOptionalFile(fs, path.resolve(cwd, taskFile));
			},
		);

		const ensureRalphProtectedDirs = (cwd: string): Effect.Effect<void, never, never> =>
			Effect.gen(function* () {
				const rootExists = yield* fs.exists(ralphDir(cwd)).pipe(Effect.orDie);
				if (!rootExists) {
					return;
				}
				yield* fs
					.makeDirectory(path.resolve(cwd, RALPH_STATE_DIR), { recursive: true })
					.pipe(Effect.orDie);
				yield* fs
					.makeDirectory(path.resolve(cwd, RALPH_ARCHIVE_DIR), { recursive: true })
					.pipe(Effect.orDie);
			});

		const writeTaskFile: RalphRepoService["writeTaskFile"] = Effect.fn("RalphRepo.writeTaskFile")(
			function* (cwd, taskFile, content) {
				yield* ensureRalphProtectedDirs(cwd);
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
				yield* ensureRalphProtectedDirs(cwd);
				yield* atomicWriteFileString(fs, target, content);
				return true;
			},
		);

		const deleteState: RalphRepoService["deleteState"] = Effect.fn("RalphRepo.deleteState")(
			function* (cwd, name, archived = false) {
				yield* fs.remove(getStatePath(cwd, name, archived), { force: true }).pipe(
					Effect.orDie,
				);
			},
		);

		const deleteTaskByLoopName: RalphRepoService["deleteTaskByLoopName"] = Effect.fn(
			"RalphRepo.deleteTaskByLoopName",
		)(function* (cwd, name, archived = false) {
			yield* fs.remove(getTaskPath(cwd, name, archived), { force: true }).pipe(
				Effect.orDie,
			);
		});

		const archiveLoop: RalphRepoService["archiveLoop"] = Effect.fn("RalphRepo.archiveLoop")(
			function* (cwd, state) {
				const srcState = getStatePath(cwd, state.name, false);
				const dstState = getStatePath(cwd, state.name, true);
				yield* ensureParentDirectory(fs, dstState);
				const hasState = yield* fs.exists(srcState).pipe(Effect.orDie);
				if (hasState) {
					yield* fs.rename(srcState, dstState).pipe(Effect.orDie);
				}

				const srcTask = path.resolve(cwd, state.taskFile);
				const ralphRoot = ralphDir(cwd);
				const archiveRoot = path.resolve(cwd, RALPH_ARCHIVE_TASKS_DIR);
				if (isPathInside(ralphRoot, srcTask) && !isPathInside(archiveRoot, srcTask)) {
					const dstTask = getTaskPath(cwd, state.name, true);
					yield* ensureParentDirectory(fs, dstTask);
					const hasTask = yield* fs.exists(srcTask).pipe(Effect.orDie);
					if (hasTask) {
						yield* fs.rename(srcTask, dstTask).pipe(Effect.orDie);
					}
				}
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
			yield* fs.remove(ralphDir(cwd), { recursive: true, force: true }).pipe(Effect.orDie);
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
