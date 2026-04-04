import { describe, expect, it } from "vitest";

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import type { RunAgentControlPromise } from "../src/agent/runtime.js";
import { createWorkerCustomTools, WORKER_DELEGATION_PROMPT } from "../src/agent/worker.js";

const agentToolDefinition: ToolDefinition = {
	name: "agent",
	label: "agent",
	description: "Manage worker agents",
	parameters: Type.Object({}),
	async execute() {
		return {
			content: [{ type: "text" as const, text: "ok" }],
			details: { ok: true },
		};
	},
};

describe("createWorkerCustomTools", () => {
	it("includes the shared worker-only tool definitions", () => {
		const runEffect: RunAgentControlPromise = async () => {
			throw new Error("unused in test");
		};

		const tools = createWorkerCustomTools(
			agentToolDefinition,
			runEffect,
		);

		expect(tools.map((tool) => tool.name)).toEqual([
			"agent",
			"apply_patch",
			"backlog",
			"memory",
			"web_search_exa",
			"crawling_exa",
			"get_code_context_exa",
			"find_thread",
			"read_thread",
		]);
	});

	it("guides workers to inspect backlog tasks without bd/beads wording", () => {
		expect(WORKER_DELEGATION_PROMPT).toContain("backlog show <id>");
		expect(WORKER_DELEGATION_PROMPT).not.toContain("bd show <id>");
		expect(WORKER_DELEGATION_PROMPT).not.toMatch(/beads/iu);
	});
});
