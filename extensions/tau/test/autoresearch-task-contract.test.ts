import { describe, expect, it } from "vitest";
import { Option } from "effect";

import { LoopContractValidationError } from "../src/loops/errors.js";
import {
	buildAutoresearchPhaseFingerprint,
	normalizeAutoresearchTaskContractInput,
	parseAutoresearchTaskDocument,
	renderAutoresearchTaskDocument,
} from "../src/autoresearch/task-contract.js";
import { makeExecutionProfile } from "./ralph-test-helpers.js";

describe("autoresearch task contract", () => {
	it("renders and parses strict frontmatter with stable workflow anchors", () => {
		const contract = normalizeAutoresearchTaskContractInput({
			title: "Optimize parser latency",
			benchmarkCommand: "bash scripts/bench.sh",
			checksCommand: Option.some("bash scripts/checks.sh"),
			metricName: "latency_ms",
			metricUnit: "ms",
			metricDirection: "lower",
			scopeRoot: "packages/app",
			scopePaths: ["src", "./src/../bench"],
			offLimits: ["./vendor", "vendor"],
			constraints: ["no-new-deps", "no-new-deps"],
			maxIterations: Option.some(12),
		});

		const taskDocument = renderAutoresearchTaskDocument(
			contract,
			"Reduce latency without changing the benchmark workload.",
		);
		expect(taskDocument).toContain("kind: autoresearch");
		expect(taskDocument).toContain("<!-- tau:autoresearch.goal:start -->");
		expect(taskDocument).toContain("<!-- tau:autoresearch.next_steps:end -->");

		const parsed = parseAutoresearchTaskDocument(
			taskDocument,
			".pi/loops/tasks/optimize-parser.md",
		);
		expect(parsed).toEqual(contract);
	});

	it("rejects scope paths that escape scope.root", () => {
		expect(() =>
			normalizeAutoresearchTaskContractInput({
				title: "Escape check",
				benchmarkCommand: "bash scripts/bench.sh",
				checksCommand: Option.none(),
				metricName: "latency_ms",
				metricUnit: "ms",
				metricDirection: "lower",
				scopeRoot: "packages/app",
				scopePaths: ["../outside"],
				offLimits: [],
				constraints: ["no-new-deps"],
				maxIterations: Option.none(),
			}),
		).toThrow(LoopContractValidationError);
	});

	it("phase fingerprint ignores notes and changes only when contract/profile changes", () => {
		const baseContract = normalizeAutoresearchTaskContractInput({
			title: "Fingerprint check",
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
		});

		const firstDoc = renderAutoresearchTaskDocument(baseContract, "first notes");
		const secondDoc = renderAutoresearchTaskDocument(baseContract, "different notes");
		const parsedFirst = parseAutoresearchTaskDocument(firstDoc, ".pi/loops/tasks/a.md");
		const parsedSecond = parseAutoresearchTaskDocument(secondDoc, ".pi/loops/tasks/a.md");

		const firstFingerprint = buildAutoresearchPhaseFingerprint(
			parsedFirst,
			makeExecutionProfile(),
		);
		const secondFingerprint = buildAutoresearchPhaseFingerprint(
			parsedSecond,
			makeExecutionProfile(),
		);
		expect(secondFingerprint).toBe(firstFingerprint);

		const changedMetricContract = normalizeAutoresearchTaskContractInput({
			title: baseContract.title,
			benchmarkCommand: baseContract.benchmark.command,
			checksCommand: baseContract.benchmark.checksCommand,
			metricName: "throughput_rps",
			metricUnit: baseContract.metric.unit,
			metricDirection: baseContract.metric.direction,
			scopeRoot: baseContract.scope.root,
			scopePaths: baseContract.scope.paths,
			offLimits: baseContract.scope.offLimits,
			constraints: baseContract.constraints,
			maxIterations: Option.map(baseContract.limits, (value) => value.maxIterations),
		});

		const changedFingerprint = buildAutoresearchPhaseFingerprint(
			changedMetricContract,
			makeExecutionProfile(),
		);
		expect(changedFingerprint).not.toBe(firstFingerprint);
	});
});
