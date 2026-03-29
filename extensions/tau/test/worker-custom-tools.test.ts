import { describe, expect, it } from "vitest";

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

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
		const tools = createWorkerCustomTools(agentToolDefinition);

		expect(tools.map((tool) => tool.name)).toEqual([
			"agent",
			"apply_patch",
			"backlog",
			"web_search_exa",
			"crawling_exa",
			"get_code_context_exa",
		]);
	});

	it("guides workers to inspect backlog tasks without bd/beads wording", () => {
		expect(WORKER_DELEGATION_PROMPT).toContain("backlog show <id>");
		expect(WORKER_DELEGATION_PROMPT).not.toContain("bd show <id>");
		expect(WORKER_DELEGATION_PROMPT).not.toMatch(/beads/iu);
	});
});
