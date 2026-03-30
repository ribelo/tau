import { describe, expect, it } from "vitest";
import { Text } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";

import { createMemoryEntry, type MemoryEntriesSnapshot } from "../src/memory/format.js";
import { renderMemoriesMessage, renderMemoryCall, renderMemoryResult } from "../src/memory/renderer.js";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function renderText(snapshot: MemoryEntriesSnapshot): string {
	return renderMemoriesMessage({ snapshot }, plainTheme).render(400).join("\n");
}

function renderToolCall(args: Record<string, unknown>): string {
	return renderMemoryCall(args, plainTheme).render(400).join("\n");
}

function renderToolResult(result: {
	readonly content: readonly { readonly type: string; readonly text?: string }[];
	readonly details?: unknown;
}): string {
	const rendered = renderMemoryResult(result, plainTheme);
	if (!(rendered instanceof Text)) {
		throw new Error("Expected memory renderer to return Text");
	}
	return rendered.render(400).join("\n");
}

describe("memory renderer", () => {
	it("renders all scopes with id, size, scope, and preview columns", () => {
		const snapshot: MemoryEntriesSnapshot = {
			project: {
				bucket: "project",
				path: "/workspace/.pi/tau/memories/PROJECT.jsonl",
				entries: [createMemoryEntry("project memory preview")],
				chars: 22,
				limitChars: 1408,
				usagePercent: 2,
			},
			global: {
				bucket: "global",
				path: "/home/test/.pi/agent/tau/memories/MEMORY.jsonl",
				entries: [createMemoryEntry("global memory preview")],
				chars: 21,
				limitChars: 1152,
				usagePercent: 2,
			},
			user: {
				bucket: "user",
				path: "/home/test/.pi/agent/tau/memories/USER.jsonl",
				entries: [createMemoryEntry("user memory preview")],
				chars: 19,
				limitChars: 1536,
				usagePercent: 3,
			},
		};

		const rendered = renderText(snapshot);

		expect(rendered).toContain("memories");
		expect(rendered).toContain("project");
		expect(rendered).toContain("global");
		expect(rendered).toContain("user");
		expect(rendered).toContain("id");
		expect(rendered).toContain("size");
		expect(rendered).toContain("scope");
		expect(rendered).toContain("preview");
		expect(rendered).toContain("project memory preview");
		expect(rendered).toContain("global memory preview");
		expect(rendered).toContain("user memory preview");
		expect(rendered).toContain(snapshot.project.entries[0]!.id);
	});

	it("aligns the /memories summary columns for counts and char totals", () => {
		const snapshot: MemoryEntriesSnapshot = {
			project: {
				bucket: "project",
				path: "/workspace/.pi/tau/memories/PROJECT.jsonl",
				entries: Array.from({ length: 7 }, (_, index) => createMemoryEntry(`project-${index}`)),
				chars: 1275,
				limitChars: 1408,
				usagePercent: 90,
			},
			global: {
				bucket: "global",
				path: "/home/test/.pi/agent/tau/memories/MEMORY.jsonl",
				entries: Array.from({ length: 11 }, (_, index) => createMemoryEntry(`global-${index}`)),
				chars: 1107,
				limitChars: 1152,
				usagePercent: 96,
			},
			user: {
				bucket: "user",
				path: "/home/test/.pi/agent/tau/memories/USER.jsonl",
				entries: Array.from({ length: 9 }, (_, index) => createMemoryEntry(`user-${index}`)),
				chars: 1452,
				limitChars: 1536,
				usagePercent: 94,
			},
		};

		const lines = renderText(snapshot).split("\n");
		const summaryLines = lines
			.filter((line) => /^\s{2}(project|global|user)\s+:/u.test(line))
			.map((line) => line.trimEnd());

		expect(summaryLines).toEqual([
			"  project : [█████████████░]  7 entries · 1275/1408 chars",
			"  global  : [█████████████░] 11 entries · 1107/1152 chars",
			"  user    : [█████████████░]  9 entries · 1452/1536 chars",
		]);
	});

	it("renders add calls with the memory content so failures stay inspectable", () => {
		const rendered = renderToolCall({
			action: "add",
			target: "project",
			content: "remember this exact\nmulti-line memory",
		});

		expect(rendered).toContain("memory add");
		expect(rendered).toContain("scope: project");
		expect(rendered).toContain("chars: 37");
		expect(rendered).toContain("content:");
		expect(rendered).toContain("remember this exact");
		expect(rendered).toContain("multi-line memory");
	});

	it("keeps the submitted content visible alongside memory file failures", () => {
		const call = renderToolCall({
			action: "add",
			target: "project",
			content: "remember this exact\nmulti-line memory",
		});
		const result = renderToolResult({
			content: [{ type: "text", text: 'Memory file error: Error: expected a nanoid\n    at ["id"]' }],
			details: { success: false },
		});

		expect(`${call}\n${result}`).toContain("remember this exact");
		expect(`${call}\n${result}`).toContain("multi-line memory");
		expect(`${call}\n${result}`).toContain("expected a nanoid");
	});

	it("normalizes CRLF content before rendering the call preview", () => {
		const rendered = renderToolCall({
			action: "add",
			target: "project",
			content: "alpha\r\nbeta",
		});

		expect(rendered).toContain("alpha");
		expect(rendered).toContain("beta");
		expect(rendered).not.toContain("\r");
	});
});
