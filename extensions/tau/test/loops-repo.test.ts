import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import { NodeFileSystem } from "@effect/platform-node";

import { LoopRepo, LoopRepoLive } from "../src/loops/repo.js";
import type {
	AutoresearchPhaseSnapshot,
	LoopPersistedState,
	LoopSessionRef,
} from "../src/loops/schema.js";
import { makeExecutionProfile } from "./ralph-test-helpers.js";

const loopRepoLayer = LoopRepoLive.pipe(Layer.provide(NodeFileSystem.layer));

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tau-loops-repo-"));
}

function makeControllerSessionRef(): LoopSessionRef {
	return {
		sessionId: "controller-session-id",
		sessionFile: "/tmp/controller.session.json",
	};
}

function makeLoopState(taskId: string): LoopPersistedState {
	return {
		taskId,
		title: `Loop ${taskId}`,
		taskFile: path.join(".pi", "loops", "tasks", `${taskId}.md`),
		kind: "ralph",
		lifecycle: "paused",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		startedAt: Option.some("2026-01-01T00:00:00.000Z"),
		completedAt: Option.none(),
		archivedAt: Option.none(),
		ownership: {
			controller: Option.some(makeControllerSessionRef()),
			child: Option.none(),
		},
		ralph: {
			iteration: 2,
			maxIterations: 20,
			itemsPerIteration: 3,
			reflectEvery: 5,
			reflectInstructions: "reflect",
			lastReflectionAt: 0,
			advanceRequestedAt: Option.none(),
			awaitingFinalize: false,
			pinnedExecutionProfile: makeExecutionProfile(),
		},
	};
}

function makePhaseSnapshot(taskId: string, phaseId: string): AutoresearchPhaseSnapshot {
	return {
		kind: "autoresearch",
		taskId,
		phaseId,
		fingerprint: `${taskId}-${phaseId}`,
		createdAt: "2026-01-01T00:00:00.000Z",
		benchmark: {
			command: "npm run bench",
			checksCommand: Option.some("npm run test:quick"),
		},
		metric: {
			name: "latency_ms",
			unit: "ms",
			direction: "lower",
		},
		scope: {
			root: ".",
			paths: ["src"],
			offLimits: ["vendor"],
		},
		constraints: ["no-new-deps"],
		pinnedExecutionProfile: makeExecutionProfile(),
	};
}

describe("loop repo", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("persists canonical loop state and task files under .pi/loops", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const loopState = makeLoopState("repo-loop");
		const loaded = await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* LoopRepo;
				yield* repo.writeTaskFile(cwd, loopState.taskId, "# Task\n");
				yield* repo.saveState(cwd, loopState);
				return yield* repo.loadState(cwd, loopState.taskId);
			}).pipe(Effect.provide(loopRepoLayer)),
		);

		expect(Option.isSome(loaded)).toBe(true);
		if (Option.isSome(loaded)) {
			expect(loaded.value).toEqual(loopState);
		}
		expect(
			fs.existsSync(path.join(cwd, ".pi", "loops", "state", "repo-loop.json")),
		).toBe(true);
		expect(
			fs.existsSync(path.join(cwd, ".pi", "loops", "tasks", "repo-loop.md")),
		).toBe(true);
	});

	it("persists phase snapshots under .pi/loops/phases/<task-id>", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const snapshot = makePhaseSnapshot("phase-loop", "phase-001");
		const loaded = await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* LoopRepo;
				yield* repo.savePhaseSnapshot(cwd, snapshot);
				return yield* repo.loadPhaseSnapshot(cwd, snapshot.taskId, snapshot.phaseId);
			}).pipe(Effect.provide(loopRepoLayer)),
		);

		expect(Option.isSome(loaded)).toBe(true);
		if (Option.isSome(loaded)) {
			expect(loaded.value).toEqual(snapshot);
		}
		expect(
			fs.existsSync(
				path.join(cwd, ".pi", "loops", "phases", snapshot.taskId, `${snapshot.phaseId}.json`),
			),
		).toBe(true);
	});

	it("archives task, state, phase, and run artifacts under .pi/loops/archive", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const loopState = makeLoopState("archive-loop");
		const snapshot = makePhaseSnapshot(loopState.taskId, "phase-001");
		await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* LoopRepo;
				yield* repo.writeTaskFile(cwd, loopState.taskId, "# Task\n");
				yield* repo.saveState(cwd, loopState);
				yield* repo.savePhaseSnapshot(cwd, snapshot);
				const runDir = yield* repo.ensureRunDirectory(cwd, loopState.taskId, "run-001");
				yield* Effect.sync(() => {
					fs.writeFileSync(path.join(runDir, "benchmark.log"), "ok\n", "utf-8");
				});
				yield* repo.archiveTaskArtifacts(cwd, loopState.taskId);
				yield* repo.saveState(
					cwd,
					{
						...loopState,
						taskFile: path.join(".pi", "loops", "archive", "tasks", `${loopState.taskId}.md`),
						lifecycle: "archived",
						archivedAt: Option.some("2026-01-01T01:00:00.000Z"),
					},
					true,
				);
				yield* repo.deleteState(cwd, loopState.taskId);
			}).pipe(Effect.provide(loopRepoLayer)),
		);

		expect(
			fs.existsSync(path.join(cwd, ".pi", "loops", "state", "archive-loop.json")),
		).toBe(false);
		expect(
			fs.existsSync(path.join(cwd, ".pi", "loops", "tasks", "archive-loop.md")),
		).toBe(false);
		expect(
			fs.existsSync(path.join(cwd, ".pi", "loops", "phases", "archive-loop")),
		).toBe(false);
		expect(
			fs.existsSync(path.join(cwd, ".pi", "loops", "runs", "archive-loop")),
		).toBe(false);

		expect(
			fs.existsSync(path.join(cwd, ".pi", "loops", "archive", "state", "archive-loop.json")),
		).toBe(true);
		expect(
			fs.existsSync(path.join(cwd, ".pi", "loops", "archive", "tasks", "archive-loop.md")),
		).toBe(true);
		expect(
			fs.existsSync(
				path.join(cwd, ".pi", "loops", "archive", "phases", "archive-loop", "phase-001.json"),
			),
		).toBe(true);
		expect(
			fs.existsSync(
				path.join(cwd, ".pi", "loops", "archive", "runs", "archive-loop", "run-001", "benchmark.log"),
			),
		).toBe(true);
	});
});
