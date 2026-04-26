import { describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import { NodeFileSystem } from "@effect/platform-node";

import { LoopRepo, LoopRepoLive } from "../src/loops/repo.js";
import { LoopEngine, LoopEngineLive } from "../src/services/loop-engine.js";
import { RalphContractResolver, RalphContractResolverLive } from "../src/ralph/resolver.js";
import {
	captureCapabilityContract,
	captureToolContract,
	captureAgentContract,
	validateCapabilityContract,
	effectiveToolNames,
	checkControlToolsExcluded,
} from "../src/ralph/resolver.js";
import {
	makeEmptyCapabilityContract,
	makeCapabilityContract,
} from "../src/ralph/contract.js";
import { PiAPI } from "../src/effect/pi.js";
import { PromptModes } from "../src/services/prompt-modes.js";

const piStub = {
	getActiveTools: () => [] as string[],
	getAllTools: () => [] as { name: string; description: string }[],
	setActiveTools: () => undefined,
} as unknown as import("@mariozechner/pi-coding-agent").ExtensionAPI;

const piLayer = Layer.succeed(PiAPI, piStub);

const promptModesStub = PromptModes.of({
	setup: Effect.void,
	captureCurrentProfile: () => Effect.succeed(null),
	captureCurrentExecutionProfile: () => Effect.succeed(null),
	applyProfile: () => Effect.succeed({ applied: true as const, profile: { mode: "default", model: "test", thinking: "medium" } }),
	applyExecutionProfile: () => Effect.succeed({ applied: true as const, profile: { mode: "default", model: "test", thinking: "medium" } }),
});

const promptModesLayer = Layer.succeed(PromptModes, promptModesStub);

const resolverLayer = RalphContractResolverLive.pipe(
	Layer.provide(LoopRepoLive),
	Layer.provide(piLayer),
	Layer.provide(promptModesLayer),
	Layer.provide(NodeFileSystem.layer),
);

describe("ralph contract resolver pure helpers", () => {
	it("captures tool contract excluding system control tools", () => {
		const contract = captureToolContract({
			activeTools: ["read", "ralph_continue", "bash", "ralph_finish"],
			allTools: [
				{ name: "read", description: "Read files" },
				{ name: "bash", description: "Run commands" },
				{ name: "ralph_continue", description: "Continue" },
			],
		});
		expect(contract.activeNames).toEqual(["read", "bash"]);
		expect(contract.availableSnapshot).toHaveLength(3);
		expect(contract.availableSnapshot[0]?.label).toBe("read");
	});

	it("captures Ralph default active tools from the available tool set", () => {
		const contract = captureToolContract({
			activeTools: ["read", "bash", "todo_write", "thread", "unknown_custom_tool"],
			allTools: [
				{ name: "read", description: "Read files" },
				{ name: "bash", description: "Run commands" },
				{ name: "apply_patch", description: "Apply patches" },
				{ name: "backlog", description: "Backlog" },
				{ name: "web_search_exa", description: "Search" },
				{ name: "crawling_exa", description: "Crawl" },
				{ name: "get_code_context_exa", description: "Code context" },
				{ name: "agent", description: "Spawn agents" },
				{ name: "memory", description: "Memory" },
				{ name: "todo_write", description: "Todo" },
				{ name: "thread", description: "Thread" },
				{ name: "ralph_continue", description: "Continue" },
				{ name: "ralph_finish", description: "Finish" },
			],
		});

		expect(contract.activeNames).toEqual([
			"read",
			"bash",
			"apply_patch",
			"backlog",
			"web_search_exa",
			"crawling_exa",
			"get_code_context_exa",
			"agent",
			"memory",
		]);
	});

	it("routes Ralph default mutation tools by provider preference", () => {
		const allTools = [
			{ name: "read", description: "Read files" },
			{ name: "edit", description: "Edit files" },
			{ name: "write", description: "Write files" },
			{ name: "apply_patch", description: "Apply patches" },
			{ name: "bash", description: "Run commands" },
		];
		const legacyContract = captureToolContract({
			activeTools: [],
			allTools,
			useApplyPatchForMutationTools: false,
		});
		const applyPatchContract = captureToolContract({
			activeTools: [],
			allTools,
			useApplyPatchForMutationTools: true,
		});

		expect(legacyContract.activeNames).toEqual(["read", "edit", "write", "bash"]);
		expect(applyPatchContract.activeNames).toEqual(["read", "apply_patch", "bash"]);
	});

	it("captures agent contract from registry and enabled list", () => {
		const registry = {
			list: () => [
				{ name: "finder", description: "Find code" },
				{ name: "oracle", description: "Deep reasoning" },
			],
		};
		const contract = captureAgentContract({
			agentRegistry: registry as unknown as import("../src/agent/agent-registry.js").AgentRegistry,
			enabledAgents: ["finder"],
		});
		expect(contract.enabledNames).toEqual(["finder"]);
		expect(contract.registrySnapshot).toHaveLength(2);
	});

	it("validates a correct contract", () => {
		const contract = makeCapabilityContract({
			toolsActiveNames: ["read", "bash"],
			toolsAvailableSnapshot: [
				{ name: "read", label: "Read", description: "Read files" },
				{ name: "bash", label: "Bash", description: "Run commands" },
				{ name: "ralph_continue", label: "Continue", description: "Continue" },
				{ name: "ralph_finish", label: "Finish", description: "Finish" },
			],
			agentsEnabledNames: ["finder"],
			agentsRegistrySnapshot: [{ name: "finder", description: "Find code" }],
		});
		const result = validateCapabilityContract(contract);
		expect(result.valid).toBe(true);
	});

	it("rejects system control tools in user-configurable activeNames", () => {
		const contract = makeCapabilityContract({
			toolsActiveNames: ["read", "ralph_continue", "bash"],
			toolsAvailableSnapshot: [{ name: "read", label: "Read", description: "Read files" }],
			agentsEnabledNames: [],
			agentsRegistrySnapshot: [],
		});
		const violations = checkControlToolsExcluded(contract);
		expect(violations).toContain("ralph_continue");
		expect(violations).not.toContain("ralph_finish");
	});

	it("reports empty snapshots in validation", () => {
		const contract = makeEmptyCapabilityContract();
		const result = validateCapabilityContract(contract);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.issues.some((i) => i.kind === "empty_tool_contract")).toBe(true);
			expect(result.issues.some((i) => i.kind === "empty_agent_contract")).toBe(true);
		}
	});

	it("reports missing pinned tools not in available snapshot", () => {
		const contract = makeCapabilityContract({
			toolsActiveNames: ["read", "missing_tool"],
			toolsAvailableSnapshot: [{ name: "read", label: "Read", description: "Read files" }],
			agentsEnabledNames: [],
			agentsRegistrySnapshot: [],
		});
		const result = validateCapabilityContract(contract);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			const issue = result.issues.find((i) => i.kind === "missing_pinned_tools");
			expect(issue).toBeDefined();
			if (issue?.kind === "missing_pinned_tools") {
				expect(issue.missing).toContain("missing_tool");
			}
		}
	});

	it("reports missing enabled agents not in registry snapshot", () => {
		const contract = makeCapabilityContract({
			toolsActiveNames: [],
			toolsAvailableSnapshot: [{ name: "read", label: "Read", description: "Read files" }],
			agentsEnabledNames: ["finder", "missing_agent"],
			agentsRegistrySnapshot: [{ name: "finder", description: "Find code" }],
		});
		const result = validateCapabilityContract(contract);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			const issue = result.issues.find((i) => i.kind === "missing_enabled_agents");
			expect(issue).toBeDefined();
			if (issue?.kind === "missing_enabled_agents") {
				expect(issue.missing).toContain("missing_agent");
			}
		}
	});

	it("reports missing ralph control tools in available snapshot", () => {
		const contract = makeCapabilityContract({
			toolsActiveNames: ["read"],
			toolsAvailableSnapshot: [{ name: "read", label: "Read", description: "Read files" }],
			agentsEnabledNames: [],
			agentsRegistrySnapshot: [],
		});
		const result = validateCapabilityContract(contract);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			const issue = result.issues.find((i) => i.kind === "missing_ralph_control_tools");
			expect(issue).toBeDefined();
			if (issue?.kind === "missing_ralph_control_tools") {
				expect(issue.missing).toContain("ralph_continue");
				expect(issue.missing).toContain("ralph_finish");
			}
		}
	});

	it("passes validation when all consistency checks are satisfied", () => {
		const contract = makeCapabilityContract({
			toolsActiveNames: ["read"],
			toolsAvailableSnapshot: [
				{ name: "read", label: "Read", description: "Read files" },
				{ name: "ralph_continue", label: "Continue", description: "Continue" },
				{ name: "ralph_finish", label: "Finish", description: "Finish" },
			],
			agentsEnabledNames: ["finder"],
			agentsRegistrySnapshot: [{ name: "finder", description: "Find code" }],
		});
		const result = validateCapabilityContract(contract);
		expect(result.valid).toBe(true);
	});

	it("computes controller effective tools without system controls", () => {
		const contract = makeCapabilityContract({
			toolsActiveNames: ["read", "bash"],
			toolsAvailableSnapshot: [],
			agentsEnabledNames: [],
			agentsRegistrySnapshot: [],
		});
		expect(effectiveToolNames(contract, "controller")).toEqual(["read", "bash"]);
	});

	it("computes child effective tools with system controls injected", () => {
		const contract = makeCapabilityContract({
			toolsActiveNames: ["read", "bash"],
			toolsAvailableSnapshot: [],
			agentsEnabledNames: [],
			agentsRegistrySnapshot: [],
		});
		const tools = effectiveToolNames(contract, "child");
		expect(tools).toContain("read");
		expect(tools).toContain("bash");
		expect(tools).toContain("ralph_continue");
		expect(tools).toContain("ralph_finish");
	});
});

describe("ralph contract resolver service", () => {
	it("resolves no loop for undefined session file", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const resolver = yield* RalphContractResolver;
				return yield* resolver.resolveOwnedLoop("/tmp", undefined);
			}).pipe(Effect.provide(resolverLayer)),
		);
		expect(Option.isNone(result)).toBe(true);
	});

	it("captures a full capability contract from runtime", async () => {
		const registry = {
			list: () => [{ name: "finder", description: "Find code" }],
		};
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const resolver = yield* RalphContractResolver;
				return yield* resolver.captureFromRuntime(
					registry as unknown as import("../src/agent/agent-registry.js").AgentRegistry,
					["finder"],
				);
			}).pipe(Effect.provide(resolverLayer)),
		);
		expect(result.version).toBe("1");
		expect(result.tools.activeNames).toEqual([]); // pi stub has no active tools
		expect(result.agents.enabledNames).toEqual(["finder"]);
	});

	it("validates a contract through the service", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const resolver = yield* RalphContractResolver;
				return yield* resolver.validate(makeEmptyCapabilityContract());
			}).pipe(Effect.provide(resolverLayer)),
		);
		expect(result.valid).toBe(false);
	});
});
