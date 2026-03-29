import { describe, expect, it } from "vitest";
import type { Theme } from "@mariozechner/pi-coding-agent";

import { createMemoryEntry, type MemoryEntriesSnapshot } from "../src/memory/format.js";
import { renderMemoriesMessage } from "../src/memory/renderer.js";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function renderText(snapshot: MemoryEntriesSnapshot): string {
	return renderMemoriesMessage({ snapshot }, plainTheme).render(400).join("\n");
}

describe("memory renderer", () => {
	it("renders all scopes with id, size, scope, and preview columns", () => {
		const snapshot: MemoryEntriesSnapshot = {
			project: {
				bucket: "project",
				path: "/workspace/.pi/tau/memories/PROJECT.jsonl",
				entries: [createMemoryEntry("project memory preview")],
				chars: 22,
				limitChars: 1000,
				usagePercent: 2,
			},
			global: {
				bucket: "global",
				path: "/home/test/.pi/agent/tau/memories/MEMORY.jsonl",
				entries: [createMemoryEntry("global memory preview")],
				chars: 21,
				limitChars: 1000,
				usagePercent: 2,
			},
			user: {
				bucket: "user",
				path: "/home/test/.pi/agent/tau/memories/USER.jsonl",
				entries: [createMemoryEntry("user memory preview")],
				chars: 19,
				limitChars: 500,
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
});
