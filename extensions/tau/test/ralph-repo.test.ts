import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import { NodeFileSystem } from "@effect/platform-node";

import { RalphRepo, RalphRepoLive } from "../src/ralph/repo.js";
import type { LoopState } from "../src/ralph/schema.js";

const ralphRepoLayer = RalphRepoLive.pipe(Layer.provide(NodeFileSystem.layer));

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tau-ralph-repo-"));
}

function makeLoopState(loopName: string): LoopState {
	return {
		name: loopName,
		taskFile: path.join(".pi", "ralph", `${loopName}.md`),
		iteration: 2,
		maxIterations: 50,
		itemsPerIteration: 0,
		reflectEvery: 0,
		reflectInstructions: "reflect",
		status: "active",
		startedAt: "2026-01-01T00:00:00.000Z",
		completedAt: Option.none(),
		lastReflectionAt: 0,
		controllerSessionFile: Option.some(`/tmp/${loopName}-controller.session.json`),
		activeIterationSessionFile: Option.some(`/tmp/${loopName}-iteration.session.json`),
		advanceRequestedAt: Option.none(),
		awaitingFinalize: false,
	};
}

describe("ralph repo", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("persists and decodes loop state through schema boundaries", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const loopState = makeLoopState("repo-loop");
		const loaded = await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* RalphRepo;
				yield* repo.saveState(cwd, loopState);
				return yield* repo.loadState(cwd, "repo-loop");
			}).pipe(Effect.provide(ralphRepoLayer)),
		);

		expect(Option.isSome(loaded)).toBe(true);
		if (Option.isSome(loaded)) {
			expect(loaded.value).toEqual(loopState);
		}
	});

	it("does not normalize different loop names to the same state file", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const loopState = makeLoopState("strict_loop");
		const loaded = await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* RalphRepo;
				yield* repo.saveState(cwd, loopState);
				return yield* repo.loadState(cwd, "strict/loop");
			}).pipe(Effect.provide(ralphRepoLayer)),
		);

		expect(Option.isNone(loaded)).toBe(true);
	});

	it("archives state and task files under .pi/ralph/archive", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const loopState = makeLoopState("sleepy-loop");
		await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* RalphRepo;
				yield* repo.saveState(cwd, {
					...loopState,
					status: "paused",
				});
				yield* repo.writeTaskFile(cwd, loopState.taskFile, "# Task\n");
				yield* repo.archiveLoop(cwd, {
					...loopState,
					status: "paused",
				});
			}).pipe(Effect.provide(ralphRepoLayer)),
		);

		expect(fs.existsSync(path.join(cwd, ".pi", "ralph", "sleepy-loop.state.json"))).toBe(false);
		expect(fs.existsSync(path.join(cwd, ".pi", "ralph", "archive", "sleepy-loop.state.json"))).toBe(true);
		expect(fs.existsSync(path.join(cwd, ".pi", "ralph", "sleepy-loop.md"))).toBe(false);
		expect(fs.existsSync(path.join(cwd, ".pi", "ralph", "archive", "sleepy-loop.md"))).toBe(true);
	});

	it("archives loop task files when loop names start with the archive prefix", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const loopState = makeLoopState("archive-loop");
		await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* RalphRepo;
				yield* repo.saveState(cwd, {
					...loopState,
					status: "paused",
				});
				yield* repo.writeTaskFile(cwd, loopState.taskFile, "# Task\n");
				yield* repo.archiveLoop(cwd, {
					...loopState,
					status: "paused",
				});
			}).pipe(Effect.provide(ralphRepoLayer)),
		);

		expect(fs.existsSync(path.join(cwd, ".pi", "ralph", "archive-loop.md"))).toBe(false);
		expect(fs.existsSync(path.join(cwd, ".pi", "ralph", "archive", "archive-loop.md"))).toBe(true);
	});
});
