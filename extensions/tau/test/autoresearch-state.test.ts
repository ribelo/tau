import { describe, expect, it } from "vitest";

import {
	createExperimentState,
	cloneExperimentState,
	reconstructStateFromJsonl,
	computeConfidence,
	findBaselineMetric,
	findBestKeptMetric,
} from "../src/autoresearch/state.js";

describe("autoresearch state", () => {
	describe("reconstructStateFromJsonl", () => {
		it("reconstructs an empty state when content is empty", () => {
			const { hasLog, state } = reconstructStateFromJsonl("");
			expect(hasLog).toBe(false);
			expect(state.results).toHaveLength(0);
			expect(state.currentSegment).toBe(0);
		});

		it("reconstructs config and runs from a single segment", () => {
			const lines = [
				JSON.stringify({
					type: "config",
					name: "speedup",
					metricName: "runtime_ms",
					metricUnit: "ms",
					bestDirection: "lower",
					benchmarkCommand: "bash autoresearch.sh",
					scopePaths: ["src"],
				}),
				JSON.stringify({ type: "run", run: 1, commit: "abc1234", metric: 100, status: "keep", description: "baseline" }),
				JSON.stringify({ type: "run", run: 2, commit: "def5678", metric: 90, status: "discard", description: "try 1" }),
			].join("\n");
			const { state } = reconstructStateFromJsonl(lines);
			expect(state.name).toBe("speedup");
			expect(state.metricName).toBe("runtime_ms");
			expect(state.currentSegment).toBe(0);
			expect(state.results).toHaveLength(2);
			expect(state.results[0]!.metric).toBe(100);
			expect(state.results[0]!.status).toBe("keep");
			expect(state.results[1]!.metric).toBe(90);
		});

		it("advances segments on multiple config headers", () => {
			const lines = [
				JSON.stringify({ type: "config", name: "seg1", scopePaths: ["a"] }),
				JSON.stringify({ run: 1, commit: "a", metric: 10, status: "keep", description: "" }),
				JSON.stringify({ type: "config", name: "seg2", scopePaths: ["b"] }),
				JSON.stringify({ run: 2, commit: "b", metric: 20, status: "keep", description: "" }),
			].join("\n");
			const { state } = reconstructStateFromJsonl(lines);
			expect(state.currentSegment).toBe(1);
			expect(state.results[0]!.segment).toBe(0);
			expect(state.results[1]!.segment).toBe(1);
		});

		it("skips malformed lines without failing", () => {
			const lines = [
				JSON.stringify({ type: "config", name: "x", scopePaths: ["src"] }),
				"this is not json",
				JSON.stringify({ run: 1, commit: "a", metric: 10, status: "keep", description: "" }),
			].join("\n");
			const { state } = reconstructStateFromJsonl(lines);
			expect(state.results).toHaveLength(1);
		});
	});

	describe("cloneExperimentState", () => {
		it("deep clones results and preserves mutability", () => {
			const state = createExperimentState();
			state.results.push({
				runNumber: 1,
				commit: "abc",
				metric: 10,
				metrics: { a: 1 },
				status: "keep",
				description: "",
				timestamp: 0,
				segment: 0,
				confidence: null,
				asi: { note: "x" },
			});
			state.secondaryMetrics.push({ name: "a", unit: "ms" });
			const cloned = cloneExperimentState(state);
			cloned.results[0]!.metrics["a"] = 99;
			cloned.results[0]!.asi = { note: "y" };
			cloned.secondaryMetrics[0]!.unit = "s";
			expect(state.results[0]!.metrics["a"]).toBe(1);
			expect(state.results[0]!.asi).toEqual({ note: "x" });
			expect(state.secondaryMetrics[0]!.unit).toBe("ms");
		});
	});

	describe("computeConfidence", () => {
		it("returns null with fewer than 3 results", () => {
			const state = createExperimentState();
			state.results.push(
				{ runNumber: 1, commit: "a", metric: 100, metrics: {}, status: "keep", description: "", timestamp: 0, segment: 0, confidence: null, asi: undefined },
				{ runNumber: 2, commit: "b", metric: 90, metrics: {}, status: "discard", description: "", timestamp: 0, segment: 0, confidence: null, asi: undefined },
			);
			expect(computeConfidence(state.results, 0, "lower")).toBeNull();
		});

		it("computes confidence for a clear improvement", () => {
			// Baseline at 100, three noisy discards around 100, one clear keep at 50.
			const results = [
				{ runNumber: 1, commit: "a", metric: 100, metrics: {}, status: "keep", description: "", timestamp: 0, segment: 0, confidence: null, asi: undefined },
				{ runNumber: 2, commit: "b", metric: 101, metrics: {}, status: "discard", description: "", timestamp: 0, segment: 0, confidence: null, asi: undefined },
				{ runNumber: 3, commit: "c", metric: 99, metrics: {}, status: "discard", description: "", timestamp: 0, segment: 0, confidence: null, asi: undefined },
				{ runNumber: 4, commit: "d", metric: 102, metrics: {}, status: "discard", description: "", timestamp: 0, segment: 0, confidence: null, asi: undefined },
				{ runNumber: 5, commit: "e", metric: 50, metrics: {}, status: "keep", description: "", timestamp: 0, segment: 0, confidence: null, asi: undefined },
			] as const;
			const confidence = computeConfidence(results as unknown as import("../src/autoresearch/schema.js").ExperimentResult[], 0, "lower");
			expect(confidence).not.toBeNull();
			expect(confidence!).toBeGreaterThan(0);
		});
	});

	describe("findBaselineMetric / findBestKeptMetric", () => {
		it("finds the first keep as baseline", () => {
			const results = [
				{ runNumber: 1, commit: "a", metric: 100, metrics: {}, status: "keep", description: "", timestamp: 0, segment: 0, confidence: null, asi: undefined },
				{ runNumber: 2, commit: "b", metric: 90, metrics: {}, status: "keep", description: "", timestamp: 0, segment: 0, confidence: null, asi: undefined },
			] as const;
			expect(findBaselineMetric(results as unknown as import("../src/autoresearch/schema.js").ExperimentResult[], 0)).toBe(100);
			expect(findBestKeptMetric(results as unknown as import("../src/autoresearch/schema.js").ExperimentResult[], 0, "lower")).toBe(90);
		});
	});
});
