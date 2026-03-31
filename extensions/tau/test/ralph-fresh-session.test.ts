import { describe, expect, it } from "vitest";
import { Option } from "effect";
import { __testing } from "../src/ralph/index.js";

describe("ralph fresh-session helpers", () => {
	it("preserves uppercase letters when sanitizing loop names", () => {
		expect(__testing.sanitize("MyFeature")).toBe("MyFeature");
		expect(__testing.sanitize("ABC-123")).toBe("ABC-123");
		expect(__testing.sanitize("alpha/beta")).toBe("alpha_beta");
	});

	it("normalizes persisted Option fields from legacy state", () => {
		const state = __testing.normalizeLoopState({
			name: "legacy-loop",
			taskFile: ".pi/ralph/legacy-loop.md",
			iteration: 3,
			maxIterations: 50,
			itemsPerIteration: 0,
			reflectEvery: 0,
			reflectInstructions: "reflect",
			status: "active",
			startedAt: "2026-01-01T00:00:00.000Z",
			lastReflectionAt: 0,
		});

		expect(state).toBeDefined();
		if (!state) throw new Error("expected normalized state");
		expect(Option.isNone(state.completedAt)).toBe(true);
		expect(Option.isNone(state.controllerSessionFile)).toBe(true);
		expect(Option.isNone(state.activeIterationSessionFile)).toBe(true);
		expect(Option.isNone(state.advanceRequestedAt)).toBe(true);
		expect(state.awaitingFinalize).toBe(false);
	});

	it("normalizes serialized Some/None controller fields", () => {
		const state = __testing.normalizeLoopState({
			name: "controller-loop",
			taskFile: ".pi/ralph/controller-loop.md",
			iteration: 1,
			maxIterations: 10,
			itemsPerIteration: 0,
			reflectEvery: 0,
			reflectInstructions: "reflect",
			status: "active",
			startedAt: "2026-01-01T00:00:00.000Z",
			completedAt: { _tag: "None" },
			lastReflectionAt: 0,
			controllerSessionFile: { _tag: "Some", value: "/tmp/controller.session" },
			activeIterationSessionFile: { _tag: "Some", value: "/tmp/iteration.session" },
			advanceRequestedAt: { _tag: "None" },
			awaitingFinalize: true,
		});

		expect(state).toBeDefined();
		if (!state) throw new Error("expected normalized state");
		expect(Option.getOrUndefined(state.controllerSessionFile)).toBe(
			"/tmp/controller.session",
		);
		expect(Option.getOrUndefined(state.activeIterationSessionFile)).toBe(
			"/tmp/iteration.session",
		);
		expect(state.awaitingFinalize).toBe(true);
	});

	it("matches controller and iteration session files", () => {
		const normalized = __testing.normalizeLoopState({
			name: "session-loop",
			taskFile: ".pi/ralph/session-loop.md",
			iteration: 2,
			maxIterations: 10,
			itemsPerIteration: 0,
			reflectEvery: 0,
			reflectInstructions: "reflect",
			status: "active",
			startedAt: "2026-01-01T00:00:00.000Z",
			completedAt: { _tag: "None" },
			lastReflectionAt: 0,
			controllerSessionFile: { _tag: "Some", value: "/tmp/controller.session" },
			activeIterationSessionFile: { _tag: "Some", value: "/tmp/iteration.session" },
			advanceRequestedAt: { _tag: "None" },
			awaitingFinalize: false,
		});

		expect(normalized).toBeDefined();
		if (!normalized) throw new Error("expected normalized state");
		expect(__testing.loopOwnsSessionFile(normalized, "/tmp/controller.session")).toBe(true);
		expect(__testing.loopOwnsSessionFile(normalized, "/tmp/iteration.session")).toBe(true);
		expect(__testing.loopOwnsSessionFile(normalized, "/tmp/other.session")).toBe(false);
	});
});
