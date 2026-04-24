import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import { NodeFileSystem } from "@effect/platform-node";

import { LoopRepo, LoopRepoLive } from "../src/loops/repo.js";
import {
	parseAutoresearchTaskDocument,
	renderAutoresearchTaskDocument,
} from "../src/autoresearch/task-contract.js";
import { LoopAmbiguousOwnershipError, LoopOwnershipValidationError } from "../src/loops/errors.js";
import type { LoopPersistedState, LoopSessionRef } from "../src/loops/schema.js";
import { LoopEngine, LoopEngineLive } from "../src/services/loop-engine.js";
import { makeExecutionProfile, makeSandboxProfile } from "./ralph-test-helpers.js";

const loopEngineLayer = LoopEngineLive.pipe(
	Layer.provideMerge(LoopRepoLive),
	Layer.provide(NodeFileSystem.layer),
);

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tau-loop-engine-"));
}

function makeSession(id: string, fileName: string): LoopSessionRef {
	return {
		sessionId: id,
		sessionFile: `/tmp/${fileName}`,
	};
}

function makeInvalidState(taskId: string, child: LoopSessionRef): LoopPersistedState {
	return {
		taskId,
		title: "Invalid",
		taskFile: path.join(".pi", "loops", "tasks", `${taskId}.md`),
		kind: "ralph",
		lifecycle: "active",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		startedAt: Option.some("2026-01-01T00:00:00.000Z"),
		completedAt: Option.none(),
		archivedAt: Option.none(),
		ownership: {
			controller: Option.none(),
			child: Option.some(child),
		},
		ralph: {
			iteration: 1,
			maxIterations: 10,
			itemsPerIteration: 2,
			reflectEvery: 5,
			reflectInstructions: "reflect",
			lastReflectionAt: 0,
			pendingDecision: Option.none(),
			pinnedExecutionProfile: makeExecutionProfile(),
			sandboxProfile: Option.some(makeSandboxProfile()),
		},
	};
}

describe("loop engine service", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("runs create/start/pause/resume/stop/archive lifecycle with persisted session identity", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const controller = makeSession("controller-1", "controller-1.session.json");
		const child = makeSession("child-1", "child-1.session.json");

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const engine = yield* LoopEngine;

				yield* engine.createLoop(cwd, {
					kind: "ralph",
					taskId: "engine-loop",
					title: "Engine loop",
					taskContent: "# Task\n",
					maxIterations: 20,
					itemsPerIteration: 3,
					reflectEvery: 5,
					reflectInstructions: "reflect",
					executionProfile: makeExecutionProfile(),
					sandboxProfile: makeSandboxProfile(),
				});

				const started = yield* engine.startLoop(cwd, "engine-loop", controller);
				const withChild = yield* engine.attachChildSession(cwd, "engine-loop", child);
				const paused = yield* engine.pauseLoop(cwd, "engine-loop");
				const resumed = yield* engine.resumeLoop(cwd, "engine-loop", controller);
				const stopped = yield* engine.stopLoop(cwd, "engine-loop");
				const archived = yield* engine.archiveLoop(cwd, "engine-loop");

				return {
					started,
					withChild,
					paused,
					resumed,
					stopped,
					archived,
				};
			}).pipe(Effect.provide(loopEngineLayer)),
		);

		expect(result.started.lifecycle).toBe("active");
		expect(Option.getOrUndefined(result.started.ownership.controller)?.sessionId).toBe(
			"controller-1",
		);
		expect(Option.getOrUndefined(result.withChild.ownership.child)?.sessionFile).toBe(
			"/tmp/child-1.session.json",
		);
		expect(result.paused.lifecycle).toBe("paused");
		expect(Option.isNone(result.paused.ownership.child)).toBe(true);
		expect(result.resumed.lifecycle).toBe("active");
		expect(result.stopped.lifecycle).toBe("completed");
		expect(result.archived.lifecycle).toBe("archived");
		expect(result.archived.taskFile).toBe(
			path.join(".pi", "loops", "archive", "tasks", "engine-loop.md"),
		);

		expect(
			fs.existsSync(path.join(cwd, ".pi", "loops", "archive", "state", "engine-loop.json")),
		).toBe(true);
		expect(fs.existsSync(path.join(cwd, ".pi", "loops", "state", "engine-loop.json"))).toBe(
			false,
		);
	});

	it("writes strict autoresearch task docs and materializes phase snapshots on start", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const controller = makeSession("controller-ar", "controller-ar.session.json");

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const engine = yield* LoopEngine;
				const repo = yield* LoopRepo;

				yield* engine.createLoop(cwd, {
					kind: "autoresearch",
					taskId: "ar-loop",
					title: "Autoresearch loop",
					taskContent: "Lower parser latency without changing workload semantics.",
					benchmarkCommand: "bash scripts/bench.sh",
					checksCommand: Option.some("bash scripts/checks.sh"),
					metricName: "latency_ms",
					metricUnit: "ms",
					metricDirection: "lower",
					scopeRoot: "packages/app",
					scopePaths: ["src", "./src/../bench"],
					offLimits: ["vendor", "./vendor"],
					constraints: ["no-new-deps", "no-new-deps"],
					maxIterations: Option.some(20),
					executionProfile: makeExecutionProfile(),
				});

				const started = yield* engine.startLoop(cwd, "ar-loop", controller);
				if (started.kind !== "autoresearch") {
					throw new Error("expected autoresearch state");
				}

				const phaseId = Option.match(started.autoresearch.phaseId, {
					onNone: () => {
						throw new Error("missing phase id after autoresearch start");
					},
					onSome: (value) => value,
				});

				const taskContent = yield* repo.readTaskFile(cwd, "ar-loop");
				if (Option.isNone(taskContent)) {
					throw new Error("missing task file");
				}
				const parsedContract = parseAutoresearchTaskDocument(
					taskContent.value,
					".pi/loops/tasks/ar-loop.md",
				);

				const snapshot = yield* repo.loadPhaseSnapshot(cwd, "ar-loop", phaseId);
				if (Option.isNone(snapshot)) {
					throw new Error("missing phase snapshot");
				}

				return {
					started,
					phaseId,
					parsedContract,
					snapshot: snapshot.value,
				};
			}).pipe(Effect.provide(loopEngineLayer)),
		);

		expect(result.started.autoresearch.scopePaths).toEqual(["bench", "src"]);
		expect(result.started.autoresearch.offLimits).toEqual(["vendor"]);
		expect(Option.getOrUndefined(result.started.autoresearch.maxIterations)).toBe(20);
		expect(result.parsedContract.scope.paths).toEqual(["bench", "src"]);
		expect(result.snapshot.phaseId).toBe(result.phaseId);
		expect(result.snapshot.metric.name).toBe("latency_ms");
		expect(
			fs.existsSync(
				path.join(cwd, ".pi", "loops", "phases", "ar-loop", `${result.phaseId}.json`),
			),
		).toBe(true);
	});

	it("starts a new autoresearch phase when phase-defining frontmatter fields change", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const controller = makeSession("controller-ar2", "controller-ar2.session.json");

		const phaseIds = await Effect.runPromise(
			Effect.gen(function* () {
				const engine = yield* LoopEngine;

				yield* engine.createLoop(cwd, {
					kind: "autoresearch",
					taskId: "ar-phase-shift",
					title: "Autoresearch phase shift",
					taskContent: "Optimize parser throughput.",
					benchmarkCommand: "bash scripts/bench.sh",
					checksCommand: Option.none(),
					metricName: "latency_ms",
					metricUnit: "ms",
					metricDirection: "lower",
					scopeRoot: ".",
					scopePaths: ["src"],
					offLimits: ["dist"],
					constraints: ["no-new-deps"],
					maxIterations: Option.none(),
					executionProfile: makeExecutionProfile(),
				});

				const started = yield* engine.startLoop(cwd, "ar-phase-shift", controller);
				if (started.kind !== "autoresearch") {
					throw new Error("expected autoresearch state");
				}

				const firstPhaseId = Option.match(started.autoresearch.phaseId, {
					onNone: () => {
						throw new Error("missing initial phase id");
					},
					onSome: (value) => value,
				});

				yield* engine.pauseLoop(cwd, "ar-phase-shift");

				const taskPath = path.join(cwd, ".pi", "loops", "tasks", "ar-phase-shift.md");
				const originalTask = fs.readFileSync(taskPath, "utf-8");
				const parsedContract = parseAutoresearchTaskDocument(
					originalTask,
					".pi/loops/tasks/ar-phase-shift.md",
				);

				const updatedTask = renderAutoresearchTaskDocument(
					{
						...parsedContract,
						metric: {
							...parsedContract.metric,
							name: "throughput_rps",
						},
					},
					"Optimize parser throughput with stable behavior.",
				);
				fs.writeFileSync(taskPath, updatedTask, "utf-8");

				const resumed = yield* engine.resumeLoop(cwd, "ar-phase-shift", controller);
				if (resumed.kind !== "autoresearch") {
					throw new Error("expected autoresearch state after resume");
				}

				const secondPhaseId = Option.match(resumed.autoresearch.phaseId, {
					onNone: () => {
						throw new Error("missing resumed phase id");
					},
					onSome: (value) => value,
				});

				return { firstPhaseId, secondPhaseId };
			}).pipe(Effect.provide(loopEngineLayer)),
		);

		expect(phaseIds.secondPhaseId).not.toBe(phaseIds.firstPhaseId);
		expect(
			fs.existsSync(
				path.join(
					cwd,
					".pi",
					"loops",
					"phases",
					"ar-phase-shift",
					`${phaseIds.firstPhaseId}.json`,
				),
			),
		).toBe(true);
		expect(
			fs.existsSync(
				path.join(
					cwd,
					".pi",
					"loops",
					"phases",
					"ar-phase-shift",
					`${phaseIds.secondPhaseId}.json`,
				),
			),
		).toBe(true);
	});

	it("captures autoresearch execution profile at phase start", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const controller = makeSession("controller-profile", "controller-profile.session.json");
		const profileAtCreate = makeExecutionProfile({
			mode: "smart",
			model: "anthropic/claude-opus-4-5",
			thinking: "medium",
		});
		const profileAtStart = makeExecutionProfile({
			mode: "rush",
			model: "openai/gpt-5-mini",
			thinking: "low",
		});

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const engine = yield* LoopEngine;
				const repo = yield* LoopRepo;

				yield* engine.createLoop(cwd, {
					kind: "autoresearch",
					taskId: "ar-profile-capture",
					title: "Autoresearch profile capture",
					taskContent: "Validate phase-start execution profile pinning.",
					benchmarkCommand: "bash scripts/bench.sh",
					checksCommand: Option.none(),
					metricName: "latency_ms",
					metricUnit: "ms",
					metricDirection: "lower",
					scopeRoot: ".",
					scopePaths: ["src"],
					offLimits: [],
					constraints: ["no-new-deps"],
					maxIterations: Option.none(),
					executionProfile: profileAtCreate,
				});

				const started = yield* engine.startLoop(
					cwd,
					"ar-profile-capture",
					controller,
					profileAtStart,
				);
				if (started.kind !== "autoresearch") {
					throw new Error("expected autoresearch state");
				}

				const phaseId = Option.match(started.autoresearch.phaseId, {
					onNone: () => {
						throw new Error("missing phase id");
					},
					onSome: (value) => value,
				});

				const snapshot = yield* repo.loadPhaseSnapshot(cwd, "ar-profile-capture", phaseId);
				if (Option.isNone(snapshot)) {
					throw new Error("missing phase snapshot");
				}

				return {
					started,
					snapshot: snapshot.value,
				};
			}).pipe(Effect.provide(loopEngineLayer)),
		);

		expect(result.started.autoresearch.pinnedExecutionProfile).toEqual(profileAtStart);
		expect(result.snapshot.pinnedExecutionProfile).toEqual(profileAtStart);
	});

	it("fails fast when ownership resolution is ambiguous", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const shared = makeSession("shared-controller", "shared-controller.session.json");

		await Effect.runPromise(
			Effect.gen(function* () {
				const engine = yield* LoopEngine;
				yield* engine.createLoop(cwd, {
					kind: "ralph",
					taskId: "ambiguous-a",
					title: "Ambiguous A",
					taskContent: "# Task\n",
					maxIterations: 10,
					itemsPerIteration: 2,
					reflectEvery: 5,
					reflectInstructions: "reflect",
					executionProfile: makeExecutionProfile(),
					sandboxProfile: makeSandboxProfile(),
				});
				yield* engine.createLoop(cwd, {
					kind: "ralph",
					taskId: "ambiguous-b",
					title: "Ambiguous B",
					taskContent: "# Task\n",
					maxIterations: 10,
					itemsPerIteration: 2,
					reflectEvery: 5,
					reflectInstructions: "reflect",
					executionProfile: makeExecutionProfile(),
					sandboxProfile: makeSandboxProfile(),
				});
				yield* engine.startLoop(cwd, "ambiguous-a", shared);
				yield* engine.pauseLoop(cwd, "ambiguous-a");
			}).pipe(Effect.provide(loopEngineLayer)),
		);

		await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* LoopRepo;
				const stateOption = yield* repo.loadState(cwd, "ambiguous-b");
				if (Option.isNone(stateOption) || stateOption.value.kind !== "ralph") {
					throw new Error("missing state");
				}
				const patched = {
					...stateOption.value,
					lifecycle: "paused" as const,
					ownership: {
						controller: Option.some(shared),
						child: Option.none(),
					},
				};
				yield* repo.saveState(cwd, patched);
			}).pipe(Effect.provide(loopEngineLayer)),
		);

		await expect(
			Effect.runPromise(
				Effect.gen(function* () {
					const engine = yield* LoopEngine;
					return yield* engine.resolveOwnedLoop(cwd, shared);
				}).pipe(Effect.provide(loopEngineLayer)),
			),
		).rejects.toBeInstanceOf(LoopAmbiguousOwnershipError);
	});

	it("fails fast on invalid persisted ownership state", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const child = makeSession("invalid-child", "invalid-child.session.json");
		await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* LoopRepo;
				yield* repo.writeTaskFile(cwd, "invalid-loop", "# Task\n");
				yield* repo.saveState(cwd, makeInvalidState("invalid-loop", child));
			}).pipe(Effect.provide(loopEngineLayer)),
		);

		await expect(
			Effect.runPromise(
				Effect.gen(function* () {
					const engine = yield* LoopEngine;
					return yield* engine.listLoops(cwd);
				}).pipe(Effect.provide(loopEngineLayer)),
			),
		).rejects.toBeInstanceOf(LoopOwnershipValidationError);
	});

	it("cleans completed loops by workflow kind", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		await Effect.runPromise(
			Effect.gen(function* () {
				const engine = yield* LoopEngine;

				yield* engine.createLoop(cwd, {
					kind: "ralph",
					taskId: "clean-ralph",
					title: "Clean Ralph",
					taskContent: "# Ralph\n",
					maxIterations: 5,
					itemsPerIteration: 1,
					reflectEvery: 2,
					reflectInstructions: "reflect",
					executionProfile: makeExecutionProfile(),
					sandboxProfile: makeSandboxProfile(),
				});
				yield* engine.startLoop(
					cwd,
					"clean-ralph",
					makeSession("c-ralph", "c-ralph.session.json"),
				);
				yield* engine.stopLoop(cwd, "clean-ralph");

				yield* engine.createLoop(cwd, {
					kind: "autoresearch",
					taskId: "clean-autoresearch",
					title: "Clean Autoresearch",
					taskContent: "Autoresearch cleanup scope.",
					benchmarkCommand: "bash scripts/bench.sh",
					checksCommand: Option.none(),
					metricName: "latency_ms",
					metricUnit: "ms",
					metricDirection: "lower",
					scopeRoot: ".",
					scopePaths: ["src"],
					offLimits: ["dist"],
					constraints: ["no-new-deps"],
					maxIterations: Option.none(),
					executionProfile: makeExecutionProfile(),
				});
				yield* engine.startLoop(
					cwd,
					"clean-autoresearch",
					makeSession("c-ar", "c-ar.session.json"),
				);
				yield* engine.stopLoop(cwd, "clean-autoresearch");

				yield* engine.cleanLoops(cwd, false, "ralph");
			}).pipe(Effect.provide(loopEngineLayer)),
		);

		expect(fs.existsSync(path.join(cwd, ".pi", "loops", "state", "clean-ralph.json"))).toBe(
			false,
		);
		expect(
			fs.existsSync(path.join(cwd, ".pi", "loops", "state", "clean-autoresearch.json")),
		).toBe(true);
	});

	it("preserves pre-block loop state snapshot for manual resolution recovery", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const blocked = await Effect.runPromise(
			Effect.gen(function* () {
				const engine = yield* LoopEngine;

				yield* engine.createLoop(cwd, {
					kind: "autoresearch",
					taskId: "blocked-autoresearch",
					title: "Blocked autoresearch",
					taskContent: "Exercise manual resolution snapshot preservation.",
					benchmarkCommand: "bash scripts/bench.sh",
					checksCommand: Option.none(),
					metricName: "latency_ms",
					metricUnit: "ms",
					metricDirection: "lower",
					scopeRoot: ".",
					scopePaths: ["src"],
					offLimits: [],
					constraints: ["no-new-deps"],
					maxIterations: Option.none(),
					executionProfile: makeExecutionProfile(),
				});

				yield* engine.startLoop(
					cwd,
					"blocked-autoresearch",
					makeSession("blocked-controller", "blocked-controller.session.json"),
				);

				return yield* engine.blockLoopForManualResolution(cwd, "blocked-autoresearch", {
					reasonCode: "autoresearch.vcs.manual_resolution",
					message: "manual recovery required",
					recoveryActions: ["inspect checkout"],
					recoveryNotes: ["pending_run=run-0001"],
				});
			}).pipe(Effect.provide(loopEngineLayer)),
		);

		const preservedNote = blocked.blocked.recoveryNotes.find((note) =>
			note.startsWith("preserved_state_base64="),
		);
		expect(preservedNote).toBeDefined();
		if (preservedNote === undefined) {
			return;
		}

		const encoded = preservedNote.slice("preserved_state_base64=".length);
		const decoded = Buffer.from(encoded, "base64").toString("utf-8");
		const parsed = JSON.parse(decoded) as { readonly kind?: unknown };
		expect(parsed.kind).toBe("autoresearch");
	});
});
