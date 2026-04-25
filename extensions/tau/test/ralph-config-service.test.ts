import { describe, expect, it } from "vitest";
import { Effect, Option } from "effect";

import {
	makeRalphLoopConfigService,
	RalphConfigLoopNotFoundError,
	RalphConfigUnsafeEditError,
} from "../src/ralph/config-service.js";
import { emptyRalphLoopMetrics } from "../src/ralph/schema.js";
import { makeEmptyCapabilityContract } from "../src/ralph/contract.js";
import type { RalphRepoService } from "../src/ralph/repo.js";
import type { LoopState } from "../src/ralph/schema.js";

function makeMockRepo(initial: LoopState): RalphRepoService {
	let state = initial;
	return {
		loadState: () =>
			Effect.succeed(
				state.name === "missing" ? Option.none() : Option.some(state),
			),
		saveState: (_cwd: string, next: LoopState) =>
			Effect.sync(() => {
				state = next;
			}),
		listLoops: () => Effect.succeed([state]),
		findLoopBySessionFile: () => Effect.succeed(Option.some(state)),
		readTaskFile: () => Effect.succeed(Option.none()),
		writeTaskFile: () => Effect.void,
		ensureTaskFile: () => Effect.succeed(false),
		deleteState: () => Effect.void,
		deleteTaskByLoopName: () => Effect.void,
		archiveLoop: () => Effect.void,
		existsRalphDirectory: () => Effect.succeed(true),
		removeRalphDirectory: () => Effect.void,
	};
}

function makeTestLoop(overrides?: Partial<LoopState>): LoopState {
	return {
		name: "test-loop",
		taskFile: ".pi/loops/tasks/test-loop.md",
		iteration: 3,
		maxIterations: 50,
		itemsPerIteration: 2,
		reflectEvery: 5,
		reflectInstructions: "Reflect now",
		status: "paused",
		startedAt: new Date().toISOString(),
		completedAt: Option.none(),
		lastReflectionAt: 0,
		controllerSessionFile: undefined,
		activeIterationSessionFile: undefined,
		pendingDecision: Option.none(),
		sandboxProfile: Option.none(),
		metrics: emptyRalphLoopMetrics(),
		executionProfile: {
			selector: { mode: "default" },
			promptProfile: { mode: "default", model: "test-model", thinking: "medium" },
			policy: { tools: { kind: "inherit" } },
		},
		capabilityContract: makeEmptyCapabilityContract(),
		...overrides,
	};
}

describe("ralph loop config service", () => {
	it("loads an existing loop", async () => {
		const loop = makeTestLoop();
		const service = makeRalphLoopConfigService(makeMockRepo(loop));
		const loaded = await service.loadLoop("/tmp", "test-loop");
		expect(loaded.name).toBe("test-loop");
	});

	it("throws for missing loop", async () => {
		const loop = makeTestLoop({ name: "missing" });
		const service = makeRalphLoopConfigService(makeMockRepo(loop));
		await expect(service.loadLoop("/tmp", "missing")).rejects.toThrow(
			RalphConfigLoopNotFoundError,
		);
	});

	it("mutates maxIterations", async () => {
		const loop = makeTestLoop();
		const service = makeRalphLoopConfigService(makeMockRepo(loop));
		const result = await service.mutate("/tmp", "test-loop", {
			kind: "maxIterations",
			value: 100,
		});
		expect(result.status).toBe("updated");
		const loaded = await service.loadLoop("/tmp", "test-loop");
		expect(loaded.maxIterations).toBe(100);
	});

	it("mutates itemsPerIteration", async () => {
		const loop = makeTestLoop();
		const service = makeRalphLoopConfigService(makeMockRepo(loop));
		const result = await service.mutate("/tmp", "test-loop", {
			kind: "itemsPerIteration",
			value: 5,
		});
		expect(result.status).toBe("updated");
		const loaded = await service.loadLoop("/tmp", "test-loop");
		expect(loaded.itemsPerIteration).toBe(5);
	});

	it("mutates reflectEvery", async () => {
		const loop = makeTestLoop();
		const service = makeRalphLoopConfigService(makeMockRepo(loop));
		const result = await service.mutate("/tmp", "test-loop", {
			kind: "reflectEvery",
			value: 10,
		});
		expect(result.status).toBe("updated");
		const loaded = await service.loadLoop("/tmp", "test-loop");
		expect(loaded.reflectEvery).toBe(10);
	});

	it("mutates reflectInstructions", async () => {
		const loop = makeTestLoop();
		const service = makeRalphLoopConfigService(makeMockRepo(loop));
		const result = await service.mutate("/tmp", "test-loop", {
			kind: "reflectInstructions",
			value: "New instructions",
		});
		expect(result.status).toBe("updated");
		const loaded = await service.loadLoop("/tmp", "test-loop");
		expect(loaded.reflectInstructions).toBe("New instructions");
	});

	it("mutates capability contract tools", async () => {
		const loop = makeTestLoop({
			capabilityContract: {
				version: "1",
				tools: {
					activeNames: ["read"],
					availableSnapshot: [
						{ name: "read", label: "Read", description: "Read files" },
						{ name: "bash", label: "Bash", description: "Run commands" },
					],
				},
				agents: {
					enabledNames: [],
					registrySnapshot: [],
				},
			},
		});
		const service = makeRalphLoopConfigService(makeMockRepo(loop));
		const result = await service.mutate("/tmp", "test-loop", {
			kind: "capabilityContractTools",
			activeNames: ["read", "bash"],
		});
		expect(result.status).toBe("updated");
		const loaded = await service.loadLoop("/tmp", "test-loop");
		expect(loaded.capabilityContract.tools.activeNames).toEqual(["read", "bash"]);
	});

	it("mutates capability contract agents", async () => {
		const loop = makeTestLoop({
			capabilityContract: {
				version: "1",
				tools: {
					activeNames: [],
					availableSnapshot: [],
				},
				agents: {
					enabledNames: ["finder"],
					registrySnapshot: [
						{ name: "finder", description: "Find code" },
						{ name: "oracle", description: "Deep reasoning" },
					],
				},
			},
		});
		const service = makeRalphLoopConfigService(makeMockRepo(loop));
		const result = await service.mutate("/tmp", "test-loop", {
			kind: "capabilityContractAgents",
			enabledNames: ["finder", "oracle"],
		});
		expect(result.status).toBe("updated");
		const loaded = await service.loadLoop("/tmp", "test-loop");
		expect(loaded.capabilityContract.agents.enabledNames).toEqual(["finder", "oracle"]);
	});

	it("returns no_change when mutation produces identical state", async () => {
		const loop = makeTestLoop({ maxIterations: 50 });
		const service = makeRalphLoopConfigService(makeMockRepo(loop));
		const result = await service.mutate("/tmp", "test-loop", {
			kind: "maxIterations",
			value: 50,
		});
		expect(result.status).toBe("no_change");
	});

	it("refuses unsafe active-child edits", async () => {
		const loop = makeTestLoop({
			status: "active",
			activeIterationSessionFile: "/tmp/session.json",
		});
		const service = makeRalphLoopConfigService(makeMockRepo(loop));
		const result = await service.mutate("/tmp", "test-loop", {
			kind: "capabilityContractTools",
			activeNames: ["read"],
		});
		expect(result.status).toBe("refused");
		expect(result.reason).toContain("active child session");
	});

	it("allows scalar mutations even with active child", async () => {
		const loop = makeTestLoop({
			status: "active",
			activeIterationSessionFile: "/tmp/session.json",
		});
		const service = makeRalphLoopConfigService(makeMockRepo(loop));
		const result = await service.mutate("/tmp", "test-loop", {
			kind: "maxIterations",
			value: 100,
		});
		expect(result.status).toBe("updated");
	});

	it("applies multiple mutations atomically", async () => {
		const loop = makeTestLoop();
		const service = makeRalphLoopConfigService(makeMockRepo(loop));
		const result = await service.mutateMany("/tmp", "test-loop", [
			{ kind: "maxIterations", value: 100 },
			{ kind: "itemsPerIteration", value: 5 },
			{ kind: "reflectEvery", value: 10 },
		]);
		expect(result.status).toBe("updated");
		const loaded = await service.loadLoop("/tmp", "test-loop");
		expect(loaded.maxIterations).toBe(100);
		expect(loaded.itemsPerIteration).toBe(5);
		expect(loaded.reflectEvery).toBe(10);
	});
});
