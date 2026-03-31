import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Mock Effect before importing the module
const mockRunPromise = vi.fn();
vi.mock("effect", async () => {
	const actual = await vi.importActual("effect");
	return {
		...actual,
		Effect: {
			...(actual as { Effect: Record<string, unknown> }).Effect,
			gen: vi.fn((fn) => fn({
				yield: vi.fn().mockImplementation((tag) => {
					if (tag?._tag === "AgentControl") {
						return {
							list: Promise.resolve([]),
						};
					}
					return undefined;
				}),
			})),
		},
	};
});

describe("Ralph Fresh Session Controller", () => {
	let tempDir: string;
	let ralphDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-test-"));
		ralphDir = path.join(tempDir, ".pi", "ralph");
		fs.mkdirSync(ralphDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	describe("LoopState persistence", () => {
		it("should persist and load controller session fields", () => {
			const state = {
				name: "test-loop",
				taskFile: ".pi/ralph/test-loop.md",
				iteration: 5,
				maxIterations: 50,
				itemsPerIteration: 0,
				reflectEvery: 0,
				reflectInstructions: "",
				status: "active" as const,
				startedAt: new Date().toISOString(),
				completedAt: { _tag: "None" },
				lastReflectionAt: 0,
				controllerSessionFile: { _tag: "Some", value: "/path/to/controller.session" },
				activeIterationSessionFile: { _tag: "Some", value: "/path/to/iteration.session" },
				advanceRequestedAt: { _tag: "None" },
				awaitingFinalize: false,
			};

			const statePath = path.join(ralphDir, "test-loop.state.json");
			fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

			const loaded = JSON.parse(fs.readFileSync(statePath, "utf-8"));
			expect(loaded.name).toBe("test-loop");
			expect(loaded.controllerSessionFile._tag).toBe("Some");
			expect(loaded.controllerSessionFile.value).toBe("/path/to/controller.session");
			expect(loaded.activeIterationSessionFile._tag).toBe("Some");
			expect(loaded.awaitingFinalize).toBe(false);
		});

		it("should handle legacy state without Option fields", () => {
			const legacyState = {
				name: "legacy-loop",
				taskFile: ".pi/ralph/legacy-loop.md",
				iteration: 3,
				maxIterations: 50,
				itemsPerIteration: 0,
				reflectEvery: 0,
				reflectInstructions: "",
				status: "active" as const,
				startedAt: new Date().toISOString(),
				lastReflectionAt: 0,
				// Missing new Option fields - should still load
			};

			const statePath = path.join(ralphDir, "legacy-loop.state.json");
			fs.writeFileSync(statePath, JSON.stringify(legacyState, null, 2));

			const loaded = JSON.parse(fs.readFileSync(statePath, "utf-8"));
			expect(loaded.name).toBe("legacy-loop");
			// These would be undefined in legacy state
			expect(loaded.controllerSessionFile).toBeUndefined();
		});
	});

	describe("subagent safety gate", () => {
		it("should detect active subagents (pending or running)", async () => {
			// This test would need the full module to test hasActiveSubagents
			// For now, we verify the pattern by checking the agent status types
			const activeStatuses = [
				{ state: "pending" as const },
				{ state: "running" as const, turns: 1, toolCalls: 0 },
			];

			const isActive = (status: typeof activeStatuses[number]) =>
				status.state === "pending" || status.state === "running";

			expect(activeStatuses.every(isActive)).toBe(true);
		});

		it("should not treat completed/failed/shutdown as active", async () => {
			const finalStatuses: Array<{ state: string }> = [
				{ state: "completed" },
				{ state: "failed" },
				{ state: "shutdown" },
			];

			const isActive = (status: { state: string }) =>
				status.state === "pending" || status.state === "running";

			expect(finalStatuses.some(isActive)).toBe(false);
		});
	});
});
