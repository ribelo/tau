import { describe, expect, it } from "vitest";

import { Text } from "@mariozechner/pi-tui";
import type { Theme, ToolRenderResultOptions } from "@mariozechner/pi-coding-agent";

import {
	createBacklogToolDefinition,
	type BacklogToolDetails,
} from "../src/backlog/tool.js";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const issue = {
	id: "tau-1",
	title: "Issue",
	status: "open",
	priority: 2,
	issue_type: "task",
	created_at: "2026-03-29T12:00:00.000Z",
	updated_at: "2026-03-29T12:00:00.000Z",
};

function renderResult(details: BacklogToolDetails, options: ToolRenderResultOptions = { expanded: true, isPartial: false }): Text {
	const tool = createBacklogToolDefinition();
	const renderResultFn = tool.renderResult as unknown as (
		result: unknown,
		options: ToolRenderResultOptions,
		theme: Theme,
	) => Text;
	const rendered = renderResultFn({ content: [], details }, options, plainTheme);
	return rendered as Text;
}

describe("backlog tool renderer", () => {
	it("renders calls", () => {
		const tool = createBacklogToolDefinition();
		const renderCallFn = tool.renderCall as unknown as (args: unknown, theme: Theme) => Text;
		const rendered = renderCallFn({ command: "show tau-1", cwd: "/tmp/workspace" }, plainTheme);
		expect(rendered).toBeInstanceOf(Text);
		expect(rendered?.render(400).join("\n")).toContain("backlog show tau-1");
	});

	it("renders every backlog result kind without throwing", () => {
		const cases: BacklogToolDetails[] = [
			{ command: "ready", kind: "ready", ok: true, data: [issue] },
			{ command: "list", kind: "list", ok: true, data: [issue] },
			{ command: "blocked", kind: "blocked", ok: true, data: [issue] },
			{ command: "show tau-1", kind: "show", ok: true, data: { ...issue, notes: "note" } },
			{ command: "dep tree tau-1", kind: "dep_tree", ok: true, data: [{ ...issue, depth: 0 }] },
			{ command: "dep list tau-1", kind: "dep_list", ok: true, data: [issue] },
			{ command: "dep add tau-1 tau-2", kind: "dep_add", ok: true, data: { issue_id: "tau-1", depends_on_id: "tau-2", type: "blocks", status: "added" } },
			{ command: "dep remove tau-1 tau-2", kind: "dep_remove", ok: true, data: { issue_id: "tau-1", depends_on_id: "tau-2", type: "blocks", status: "removed" } },
			{ command: "create \"Issue\"", kind: "create", ok: true, data: issue },
			{ command: "update tau-1", kind: "update", ok: true, data: issue },
			{ command: "close tau-1", kind: "close", ok: true, data: { ...issue, status: "closed" } },
			{ command: "reopen tau-1", kind: "reopen", ok: true, data: issue },
			{ command: "status", kind: "status", ok: true, data: { total_issues: 1, open_issues: 1, in_progress_issues: 0, closed_issues: 0, blocked_issues: 0, ready_issues: 1, deferred_issues: 0, pinned_issues: 0 } },
			{ command: "comment tau-1", kind: "comment", ok: true, data: [{ id: 1, issue_id: "tau-1", author: "alice", text: "hello", created_at: "2026-03-29T12:00:00.000Z" }] },
			{ command: "comments tau-1", kind: "comments", ok: true, data: [{ id: 1, issue_id: "tau-1", author: "alice", text: "hello", created_at: "2026-03-29T12:00:00.000Z" }] },
			{ command: "search issue", kind: "search", ok: true, data: [issue] },
			{ command: "help", kind: "help", ok: true, outputText: "help" },
			{ command: "unknown", kind: "unknown", ok: false, outputText: "Unknown backlog command" },
			{ command: "error", kind: "error", ok: false, outputText: "Backlog command failed" },
		];

		for (const details of cases) {
			const rendered = renderResult(details);
			expect(rendered).toBeInstanceOf(Text);
			expect(() => rendered.render(400)).not.toThrow();
		}
	});

	it("renders partial results without details fallback safely", () => {
		const tool = createBacklogToolDefinition();
		const renderResultFn = tool.renderResult as unknown as (
			result: unknown,
			options: ToolRenderResultOptions,
			theme: Theme,
		) => Text;
		const rendered = renderResultFn({ content: [] }, { expanded: false, isPartial: true }, plainTheme);
		expect(rendered).toBeInstanceOf(Text);
		expect(rendered?.render(400).join("\n")).toContain("(no backlog details)");
	});
});
