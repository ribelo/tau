import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer, ManagedRuntime } from "effect";

import { AutoresearchRepoLive } from "../src/autoresearch/repo.js";
import { Autoresearch, AutoresearchLive, type AutoresearchExecutionBoundary } from "../src/services/autoresearch.js";

type AutoresearchRuntimeHarness = {
	run: <A, E>(effect: Effect.Effect<A, E, Autoresearch>) => Promise<A>;
	dispose: () => Promise<void>;
};

function makeAutoresearchRuntime(): AutoresearchRuntimeHarness {
	const layer = AutoresearchLive.pipe(Layer.provide(AutoresearchRepoLive), Layer.provide(NodeFileSystem.layer));
	const runtime = ManagedRuntime.make(layer);
	return {
		run: (effect) => runtime.runPromise(effect),
		dispose: () => runtime.dispose(),
	};
}

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tau-autoresearch-"));
}

function writeAutoresearchMd(workDir: string, content: string): void {
	fs.writeFileSync(path.join(workDir, "autoresearch.md"), content, "utf-8");
}

function writeAutoresearchSh(workDir: string, content: string): void {
	fs.writeFileSync(path.join(workDir, "autoresearch.sh"), content, "utf-8");
}

function writeAutoresearchConfigJson(cwd: string, content: string): void {
	fs.writeFileSync(path.join(cwd, "autoresearch.config.json"), content, "utf-8");
}

const BASELINE_MD = `# Autoresearch Plan

## Benchmark
- Command: bash autoresearch.sh
- Primary metric: runtime_ms
- Direction: lower

## Files in Scope
- src

## Off Limits
- src/legacy

## Constraints
- no regressions
`;

const BASELINE_SH = "#!/bin/bash\necho 'METRIC runtime_ms=100'";

function fakeBoundary(runDetails: {
	passed: boolean;
	parsedPrimary: number | null;
	checksPass: boolean | null;
}): AutoresearchExecutionBoundary {
	return {
		executeBenchmark: () =>
			Effect.succeed({
				runNumber: 1,
				runDirectory: "/tmp/run-0001",
				benchmarkLogPath: "/tmp/run-0001/benchmark.log",
				checksLogPath: { _tag: "None" } as never,
				command: "bash autoresearch.sh",
				exitCode: runDetails.passed ? 0 : 1,
				durationSeconds: 1.5,
				passed: runDetails.passed,
				crashed: !runDetails.passed,
				timedOut: false,
				tailOutput: "output",
				checksPass: runDetails.checksPass,
				checksTimedOut: false,
				checksOutput: "",
				checksDuration: 0,
				parsedMetrics: runDetails.parsedPrimary !== null ? { runtime_ms: runDetails.parsedPrimary } : null,
				parsedPrimary: runDetails.parsedPrimary,
				parsedAsi: null,
				metricName: "runtime_ms",
				metricUnit: "ms",
				fullOutputPath: { _tag: "None" } as never,
			}),
		commitKeep: () => Effect.succeed({ commit: "abc1234", note: "committed" }),
		revertNonKeep: () => Effect.succeed({ note: "reverted" }),
		sendFollowUp: () => Effect.void,
	};
}

describe("autoresearch service freeze", () => {
	const tempDirs: string[] = [];
	const runtimes: AutoresearchRuntimeHarness[] = [];

	afterEach(async () => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		for (const runtime of runtimes.splice(0)) {
			await runtime.dispose();
		}
	});

	it("init_experiment validates against autoresearch.md contract", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);
		writeAutoresearchMd(cwd, BASELINE_MD);
		writeAutoresearchSh(cwd, BASELINE_SH);

		const harness = makeAutoresearchRuntime();
		runtimes.push(harness);

		const result = await harness.run(
			Effect.gen(function* () {
				const service = yield* Autoresearch;
				return yield* service.initExperiment("s1", cwd, {
					name: "speedup",
					metricName: "runtime_ms",
					metricUnit: "",
					direction: "lower",
					benchmarkCommand: "bash autoresearch.sh",
					scopePaths: ["src"],
					offLimits: ["src/legacy"],
					constraints: ["no regressions"],
				});
			}),
		);

		expect(result.segment).toBe(0);
		expect(result.isReinitializing).toBe(false);
		expect(fs.existsSync(path.join(cwd, "autoresearch.jsonl"))).toBe(true);
	});

	it("run_experiment enforces autoresearch.sh guard", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);
		writeAutoresearchMd(cwd, BASELINE_MD);
		writeAutoresearchSh(cwd, BASELINE_SH);

		const harness = makeAutoresearchRuntime();
		runtimes.push(harness);

		await harness.run(
			Effect.gen(function* () {
				const service = yield* Autoresearch;
				yield* service.initExperiment("s1", cwd, {
					name: "speedup",
					metricName: "runtime_ms",
					metricUnit: "",
					direction: "lower",
					benchmarkCommand: "bash autoresearch.sh",
					scopePaths: ["src"],
					offLimits: ["src/legacy"],
					constraints: ["no regressions"],
				});
			}),
		);

		const runResult = await harness.run(
			Effect.gen(function* () {
				const service = yield* Autoresearch;
				return yield* service.runExperiment(
					"s1",
					cwd,
					{ command: "bash autoresearch.sh", timeoutSeconds: 60, checksTimeoutSeconds: 60 },
					fakeBoundary({ passed: true, parsedPrimary: 95, checksPass: null }),
				);
			}),
		);

		expect(runResult.passed).toBe(true);
		expect(runResult.parsedPrimary).toBe(95);
	});

	it("log_experiment commits on keep and reverts on discard", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);
		writeAutoresearchMd(cwd, BASELINE_MD);
		writeAutoresearchSh(cwd, BASELINE_SH);

		const harness = makeAutoresearchRuntime();
		runtimes.push(harness);

		await harness.run(
			Effect.gen(function* () {
				const service = yield* Autoresearch;
				yield* service.initExperiment("s1", cwd, {
					name: "speedup",
					metricName: "runtime_ms",
					metricUnit: "",
					direction: "lower",
					benchmarkCommand: "bash autoresearch.sh",
					scopePaths: ["src"],
					offLimits: ["src/legacy"],
					constraints: ["no regressions"],
				});
			}),
		);

		await harness.run(
			Effect.gen(function* () {
				const service = yield* Autoresearch;
				yield* service.runExperiment(
					"s1",
					cwd,
					{ command: "bash autoresearch.sh", timeoutSeconds: 60, checksTimeoutSeconds: 60 },
					fakeBoundary({ passed: true, parsedPrimary: 95, checksPass: null }),
				);
			}),
		);

		const logResult = await harness.run(
			Effect.gen(function* () {
				const service = yield* Autoresearch;
				return yield* service.logExperiment(
					"s1",
					cwd,
					{
						commit: "deadbeef",
						metric: 95,
						status: "keep",
						description: "improved loop",
						metrics: undefined,
						force: false,
						asi: { hypothesis: "unrolled loop" },
					},
					fakeBoundary({ passed: true, parsedPrimary: 95, checksPass: null }),
				);
			}),
		);

		expect(logResult.status).toBe("keep");
		expect(logResult.gitNote).toBe("committed");

		// second run -> discard
		await harness.run(
			Effect.gen(function* () {
				const service = yield* Autoresearch;
				yield* service.runExperiment(
					"s1",
					cwd,
					{ command: "bash autoresearch.sh", timeoutSeconds: 60, checksTimeoutSeconds: 60 },
					fakeBoundary({ passed: true, parsedPrimary: 105, checksPass: null }),
				);
			}),
		);

		const discardResult = await harness.run(
			Effect.gen(function* () {
				const service = yield* Autoresearch;
				return yield* service.logExperiment(
					"s1",
					cwd,
					{
						commit: "cafebabe",
						metric: 105,
						status: "discard",
						description: "regressed",
						metrics: undefined,
						force: false,
						asi: { hypothesis: "bad idea", rollback_reason: "slower", next_action_hint: "try cache" },
					},
					fakeBoundary({ passed: true, parsedPrimary: 105, checksPass: null }),
				);
			}),
		);

		expect(discardResult.status).toBe("discard");
		expect(discardResult.gitNote).toBe("reverted");
	});

	it("rehydrate reconstructs state from jsonl", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);
		fs.writeFileSync(
			path.join(cwd, "autoresearch.jsonl"),
			[
				JSON.stringify({ type: "config", name: "legacy", metricName: "ms", scopePaths: ["src"] }),
				JSON.stringify({ run: 1, commit: "aaa", metric: 50, status: "keep", description: "base" }),
			].join("\n") + "\n",
			"utf-8",
		);

		const harness = makeAutoresearchRuntime();
		runtimes.push(harness);

		const view = await harness.run(
			Effect.gen(function* () {
				const service = yield* Autoresearch;
				yield* service.rehydrate("s1", cwd);
				return yield* service.getViewData("s1");
			}),
		);

		expect(view.name).toBe("legacy");
		expect(view.metricName).toBe("ms");
		expect(view.currentSegmentRunCount).toBe(1);
	});
});
