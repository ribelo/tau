import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { AgentEndEvent } from "@mariozechner/pi-coding-agent";
import { Deferred, Effect, Fiber, Layer, Option } from "effect";
import { NodeFileSystem } from "@effect/platform-node";

import type { ExecutionProfile } from "../src/execution/schema.js";
import { RalphRepo, RalphRepoLive } from "../src/ralph/repo.js";
import {
	Ralph,
	RalphLive,
	type RalphCommandBoundary,
} from "../src/services/ralph.js";
import type { LoopState } from "../src/ralph/schema.js";
import {
	makeExecutionProfile,
	makeExecutionProfileForPrompt,
	makePromptProfile,
} from "./ralph-test-helpers.js";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tau-ralph-core-"));
}

function makeState(loopName: string, sessionFile: string): LoopState {
	return {
		name: loopName,
		taskFile: path.join(".pi", "ralph", "tasks", `${loopName}.md`),
		iteration: 3,
		maxIterations: 50,
		itemsPerIteration: 0,
		reflectEvery: 0,
		reflectInstructions: "reflect",
		status: "active",
		startedAt: "2026-01-01T00:00:00.000Z",
		completedAt: Option.none(),
		lastReflectionAt: 0,
		controllerSessionFile: Option.some(path.join(path.dirname(sessionFile), "controller.session.json")),
		activeIterationSessionFile: Option.some(sessionFile),
		advanceRequestedAt: Option.none(),
		awaitingFinalize: false,
		executionProfile: makeExecutionProfile(),
	};
}

function makeAgentEndEvent(text: string): AgentEndEvent {
	const event: unknown = {
		type: "agent_end",
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text }],
			},
		],
	};
	return event as AgentEndEvent;
}

const ralphLayer = RalphLive({
	hasActiveSubagents: () => Effect.succeed(false),
}).pipe(Layer.provideMerge(RalphRepoLive), Layer.provide(NodeFileSystem.layer));

describe("ralph core service", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("records iteration completion through service state machine", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);
		const sessionFile = path.join(cwd, ".pi", "sessions", "owned.session.json");

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* RalphRepo;
				const ralph = yield* Ralph;
				yield* repo.saveState(cwd, makeState("service-loop", sessionFile));
				const done = yield* ralph.recordIterationDone(cwd, sessionFile);
				const saved = yield* repo.loadState(cwd, "service-loop");
				return { done, saved };
			}).pipe(Effect.provide(ralphLayer)),
		);

		expect(result.done.text).toContain("Iteration 3 complete. Finalize recorded.");
		expect(Option.isSome(result.saved)).toBe(true);
		if (Option.isSome(result.saved)) {
			expect(result.saved.value.awaitingFinalize).toBe(true);
			expect(Option.isSome(result.saved.value.advanceRequestedAt)).toBe(true);
		}
	});

	it("requires iteration-session ownership for ralph_done and does not fallback to current-loop memory", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);
		const ownedSessionFile = path.join(cwd, ".pi", "sessions", "owned.session.json");
		const unrelatedSessionFile = path.join(cwd, ".pi", "sessions", "unrelated.session.json");

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* RalphRepo;
				const ralph = yield* Ralph;
				yield* repo.saveState(cwd, makeState("strict-loop", ownedSessionFile));
				yield* ralph.syncCurrentLoopFromSession(cwd, ownedSessionFile);
				const done = yield* ralph.recordIterationDone(cwd, unrelatedSessionFile);
				const saved = yield* repo.loadState(cwd, "strict-loop");
				return { done, saved };
			}).pipe(Effect.provide(ralphLayer)),
		);

		expect(result.done.text).toBe("No active Ralph loop.");
		expect(Option.isSome(result.saved)).toBe(true);
		if (Option.isSome(result.saved)) {
			expect(result.saved.value.awaitingFinalize).toBe(false);
			expect(Option.isNone(result.saved.value.advanceRequestedAt)).toBe(true);
		}
	});

	it("preserves the current Ralph loop across session sync misses so the UI can stay visible", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);
		const controllerSessionFile = path.join(cwd, ".pi", "sessions", "controller.session.json");
		const unrelatedSessionFile = path.join(cwd, ".pi", "sessions", "other.session.json");

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const ralph = yield* Ralph;
				yield* ralph.startLoopState(cwd, {
					loopName: "visible-loop",
					taskFile: path.join(".pi", "ralph", "tasks", "visible-loop.md"),
					executionProfile: makeExecutionProfile({ mode: "smart", model: "anthropic/claude-opus-4-5", thinking: "medium" }),
					maxIterations: 50,
					itemsPerIteration: 0,
					reflectEvery: 0,
					reflectInstructions: "reflect",
					controllerSessionFile: Option.some(controllerSessionFile),
					defaultTaskTemplate: "# Task\n",
				});
				yield* ralph.syncCurrentLoopFromSession(cwd, unrelatedSessionFile);
				return yield* ralph.resolveLoopForUi(cwd, unrelatedSessionFile);
			}).pipe(Effect.provide(ralphLayer)),
		);

		expect(Option.isSome(result)).toBe(true);
		if (Option.isSome(result)) {
			expect(result.value.name).toBe("visible-loop");
			expect(result.value.status).toBe("active");
		}
	});

	it("registers and scopes pending agent_end waits before follow-up dispatch", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);
		const loopName = "handshake-loop";
		const iterationSessionFile = path.join(cwd, ".pi", "sessions", "iteration.session.json");
		const controllerSessionFile = path.join(cwd, ".pi", "sessions", "controller.session.json");
		const unrelatedSessionFile = path.join(cwd, ".pi", "sessions", "unrelated.session.json");

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* RalphRepo;
				const ralph = yield* Ralph;
				yield* repo.saveState(cwd, {
					...makeState(loopName, iterationSessionFile),
					iteration: 0,
					controllerSessionFile: Option.some(controllerSessionFile),
					activeIterationSessionFile: Option.none(),
				});
				yield* repo.writeTaskFile(cwd, path.join(".pi", "ralph", "tasks", `${loopName}.md`), "# Task\n");

				const followUpStarted = yield* Deferred.make<void>();
				const releaseFollowUp = yield* Deferred.make<void>();
				let sessionFile = controllerSessionFile;

				const boundary: RalphCommandBoundary = {
					cwd,
					getSessionFile: () => sessionFile,
					switchSession: (targetSessionFile) =>
						Effect.sync(() => {
							sessionFile = targetSessionFile;
							return { cancelled: false } as const;
						}),
					newSession: () =>
						Effect.sync(() => {
							sessionFile = iterationSessionFile;
							return { cancelled: false } as const;
						}),
					applyExecutionProfile: () => Effect.succeed({ applied: true as const }),
					sendFollowUp: () =>
						Effect.gen(function* () {
							yield* Deferred.succeed(followUpStarted, undefined);
							yield* Deferred.await(releaseFollowUp);
						}),
				};

				const runFiber = yield* Effect.forkDetach(ralph.runLoop(boundary, loopName));
				yield* Deferred.await(followUpStarted);

				const unrelated = yield* ralph.handleAgentEnd(
					cwd,
					unrelatedSessionFile,
					makeAgentEndEvent("unrelated"),
				);
				const matching = yield* ralph.handleAgentEnd(
					cwd,
					iterationSessionFile,
					makeAgentEndEvent("worked"),
				);

				yield* Deferred.succeed(releaseFollowUp, undefined);
				const runResult = yield* Fiber.join(runFiber).pipe(Effect.timeout("500 millis"));

				return { unrelated, matching, runResult };
			}).pipe(Effect.provide(ralphLayer)),
		);

		expect(result.unrelated.consumedByWaitingLoop).toBe(false);
		expect(result.matching.consumedByWaitingLoop).toBe(true);
		expect(result.runResult.status).toBe("stopped");
		expect(Option.isSome(result.runResult.message)).toBe(true);
	});

	it("reapplies the pinned execution profile on each Ralph iteration", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);
		const loopName = "profile-loop";
		const controllerSessionFile = path.join(cwd, ".pi", "sessions", "controller.session.json");
		const iterationSessionFileA = path.join(cwd, ".pi", "sessions", "iteration-a.session.json");
		const iterationSessionFileB = path.join(cwd, ".pi", "sessions", "iteration-b.session.json");

		const initialProfile = makePromptProfile({
			mode: "deep",
			model: "openai-codex/gpt-5.3-codex",
			thinking: "high",
		});
		const pinnedExecutionProfile = makeExecutionProfileForPrompt(initialProfile);

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* RalphRepo;
				const ralph = yield* Ralph;
				yield* repo.saveState(cwd, {
					...makeState(loopName, iterationSessionFileA),
					iteration: 0,
					controllerSessionFile: Option.some(controllerSessionFile),
					activeIterationSessionFile: Option.none(),
					executionProfile: pinnedExecutionProfile,
				});
				yield* repo.writeTaskFile(cwd, path.join(".pi", "ralph", "tasks", `${loopName}.md`), "# Task\n");

				const appliedProfiles: ExecutionProfile[] = [];
				let sessionFile = controllerSessionFile;
				let newSessionCount = 0;

				const makeBoundary = (
					followUpStarted: Deferred.Deferred<void>,
					releaseFollowUp: Deferred.Deferred<void>,
				): RalphCommandBoundary => ({
					cwd,
					getSessionFile: () => sessionFile,
					switchSession: (targetSessionFile) =>
						Effect.sync(() => {
							sessionFile = targetSessionFile;
							return { cancelled: false } as const;
						}),
					newSession: () =>
						Effect.sync(() => {
							newSessionCount += 1;
							sessionFile = newSessionCount === 1 ? iterationSessionFileA : iterationSessionFileB;
							return { cancelled: false } as const;
						}),
					applyExecutionProfile: (profile) =>
						Effect.sync(() => {
							appliedProfiles.push(profile);
							return { applied: true } as const;
						}),
					sendFollowUp: () =>
						Effect.gen(function* () {
							yield* Deferred.succeed(followUpStarted, undefined);
							yield* Deferred.await(releaseFollowUp);
						}),
				});

				const startedA = yield* Deferred.make<void>();
				const releaseA = yield* Deferred.make<void>();
				const runFiberA = yield* Effect.forkDetach(ralph.runLoop(makeBoundary(startedA, releaseA), loopName));
				yield* Deferred.await(startedA);
				yield* ralph.handleAgentEnd(cwd, iterationSessionFileA, makeAgentEndEvent("worked"));
				yield* Deferred.succeed(releaseA, undefined);
				yield* Fiber.join(runFiberA);

				yield* ralph.resumeLoopState(cwd, loopName);

				const startedB = yield* Deferred.make<void>();
				const releaseB = yield* Deferred.make<void>();
				const runFiberB = yield* Effect.forkDetach(ralph.runLoop(makeBoundary(startedB, releaseB), loopName));
				yield* Deferred.await(startedB);
				yield* ralph.handleAgentEnd(cwd, iterationSessionFileB, makeAgentEndEvent("worked again"));
				yield* Deferred.succeed(releaseB, undefined);
				yield* Fiber.join(runFiberB);

				return appliedProfiles;
			}).pipe(Effect.provide(ralphLayer)),
		);

		expect(result).toEqual([pinnedExecutionProfile, pinnedExecutionProfile]);
	});

	it("handles current-loop pause, resume, and stop through command-side Ralph methods", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);
		const sessionFile = path.join(cwd, ".pi", "sessions", "current-loop.session.json");

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* RalphRepo;
				const ralph = yield* Ralph;
				yield* repo.saveState(cwd, makeState("current-loop", sessionFile));
				yield* ralph.syncCurrentLoopFromSession(cwd, sessionFile);

				const paused = yield* ralph.pauseCurrentLoop(cwd);
				const pausedState = yield* repo.loadState(cwd, "current-loop");
				const resumed = yield* ralph.resumeLoopState(cwd, "current-loop");
				const stopped = yield* ralph.stopActiveLoop(cwd);
				const stoppedState = yield* repo.loadState(cwd, "current-loop");

				return { paused, pausedState, resumed, stopped, stoppedState };
			}).pipe(Effect.provide(ralphLayer)),
		);

		expect(result.paused.status).toBe("paused");
		expect(result.resumed.status).toBe("resumed");
		expect(result.stopped.status).toBe("stopped");
		expect(Option.isSome(result.pausedState)).toBe(true);
		expect(Option.isSome(result.stoppedState)).toBe(true);
		if (Option.isSome(result.pausedState)) {
			expect(result.pausedState.value.status).toBe("paused");
		}
		if (Option.isSome(result.stoppedState)) {
			expect(result.stoppedState.value.status).toBe("completed");
			expect(Option.isSome(result.stoppedState.value.completedAt)).toBe(true);
		}
	});

	it("archives, cleans, and nukes through Ralph service command flows", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);
		const sessionFile = path.join(cwd, ".pi", "sessions", "controller.session.json");

		const beforeNuke = await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* RalphRepo;
				const ralph = yield* Ralph;

				const archivedLoop: LoopState = {
					...makeState("sleepy-loop", sessionFile),
					status: "paused",
					activeIterationSessionFile: Option.none(),
				};
				yield* repo.saveState(cwd, archivedLoop);
				yield* repo.writeTaskFile(cwd, archivedLoop.taskFile, "# Task\n");

				const doneA: LoopState = {
					...makeState("done-a", sessionFile),
					status: "completed",
					completedAt: Option.some("2026-01-01T00:00:00.000Z"),
				};
				const doneB: LoopState = {
					...makeState("done-b", sessionFile),
					status: "completed",
					completedAt: Option.some("2026-01-01T00:00:00.000Z"),
				};
				yield* repo.saveState(cwd, doneA);
				yield* repo.writeTaskFile(cwd, doneA.taskFile, "# Task\n");
				yield* repo.saveState(cwd, doneB);
				yield* repo.writeTaskFile(cwd, doneB.taskFile, "# Task\n");

				const archived = yield* ralph.archiveLoopByName(cwd, "sleepy-loop");
				const cleaned = yield* ralph.cleanCompletedLoops(cwd, true);
				return { archived, cleaned };
			}).pipe(Effect.provide(ralphLayer)),
		);

		expect(beforeNuke.archived.status).toBe("archived");
		expect(beforeNuke.cleaned.cleanedLoops).toEqual(["done-a", "done-b"]);
		expect(fs.existsSync(path.join(cwd, ".pi", "ralph", "state", "sleepy-loop.state.json"))).toBe(false);
		expect(fs.existsSync(path.join(cwd, ".pi", "ralph", "tasks", "sleepy-loop.md"))).toBe(false);
		expect(fs.existsSync(path.join(cwd, ".pi", "ralph", "archive", "state", "sleepy-loop.state.json"))).toBe(true);
		expect(fs.existsSync(path.join(cwd, ".pi", "ralph", "archive", "tasks", "sleepy-loop.md"))).toBe(true);
		expect(fs.existsSync(path.join(cwd, ".pi", "ralph", "state", "done-a.state.json"))).toBe(false);
		expect(fs.existsSync(path.join(cwd, ".pi", "ralph", "tasks", "done-a.md"))).toBe(false);
		expect(fs.existsSync(path.join(cwd, ".pi", "ralph", "state", "done-b.state.json"))).toBe(false);
		expect(fs.existsSync(path.join(cwd, ".pi", "ralph", "tasks", "done-b.md"))).toBe(false);

		const nuked = await Effect.runPromise(
			Effect.gen(function* () {
				const ralph = yield* Ralph;
				return yield* ralph.nukeLoops(cwd);
			}).pipe(Effect.provide(ralphLayer)),
		);

		expect(nuked.removed).toBe(true);
		expect(fs.existsSync(path.join(cwd, ".pi", "ralph"))).toBe(false);
	});
});
