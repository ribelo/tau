import { describe, expect, it } from "vitest";

import {
	ENTRY_DELIMITER,
	charCount,
	joinEntries,
	parseEntries,
	renderMemorySnapshotXml,
	type MemorySnapshot,
} from "../src/memory/format.js";

function makeSnapshot(partial: Partial<MemorySnapshot> = {}): MemorySnapshot {
	return {
		project: {
			bucket: "project",
			path: "/workspace/.pi/tau/memories/PROJECT.md",
			entries: [],
			chars: 0,
			limitChars: 2200,
			usagePercent: 0,
		},
		global: {
			bucket: "global",
			path: "/home/test/.pi/agent/tau/memories/MEMORY.md",
			entries: [],
			chars: 0,
			limitChars: 2200,
			usagePercent: 0,
		},
		user: {
			bucket: "user",
			path: "/home/test/.pi/agent/tau/memories/USER.md",
			entries: [],
			chars: 0,
			limitChars: 1375,
			usagePercent: 0,
		},
		...partial,
	};
}

describe("memory format helpers", () => {
	it("parses trimmed entries and removes empty segments", () => {
		const raw = `\n  first entry  ${ENTRY_DELIMITER}${ENTRY_DELIMITER}  second entry\nwith two lines  \n`;

		expect(parseEntries(raw)).toEqual(["first entry", "second entry\nwith two lines"]);
	});

	it("returns no entries for blank content", () => {
		expect(parseEntries("")).toEqual([]);
		expect(parseEntries(" \n\t ")).toEqual([]);
	});

	it("splits only on the exact delimiter", () => {
		const raw = `keeps § inside the entry${ENTRY_DELIMITER}next entry`;

		expect(parseEntries(raw)).toEqual(["keeps § inside the entry", "next entry"]);
	});

	it("joins entries with the section delimiter", () => {
		expect(joinEntries(["first", "second", "third"])).toBe(
			`first${ENTRY_DELIMITER}second${ENTRY_DELIMITER}third`,
		);
	});

	it("counts characters including delimiters", () => {
		const entries = ["abc", "de"];

		expect(charCount(entries)).toBe(joinEntries(entries).length);
		expect(charCount(entries)).toBe(3 + ENTRY_DELIMITER.length + 2);
		expect(charCount([])).toBe(0);
	});

	it("renders an empty XML snapshot when every scope is empty and empty scopes are omitted", () => {
		expect(renderMemorySnapshotXml(makeSnapshot(), { includeEmpty: false })).toBe("");
	});

	it("renders an XML snapshot with backing file paths and escaped content", () => {
		const projectEntries = ["alpha"];
		const globalEntries = ["beta & <gamma>"];
		const userEntries = ["zed"];

		expect(
			renderMemorySnapshotXml(
				makeSnapshot({
					project: {
						bucket: "project",
						path: "/workspace/.pi/tau/memories/PROJECT.md",
						entries: projectEntries,
						chars: charCount(projectEntries),
						limitChars: 2200,
						usagePercent: Math.floor((charCount(projectEntries) / 2200) * 100),
					},
					global: {
						bucket: "global",
						path: "/home/test/.pi/agent/tau/memories/MEMORY.md",
						entries: globalEntries,
						chars: charCount(globalEntries),
						limitChars: 2200,
						usagePercent: Math.floor((charCount(globalEntries) / 2200) * 100),
					},
					user: {
						bucket: "user",
						path: "/home/test/.pi/agent/tau/memories/USER.md",
						entries: userEntries,
						chars: charCount(userEntries),
						limitChars: 10,
						usagePercent: Math.floor((charCount(userEntries) / 10) * 100),
					},
				}),
				{ includeEmpty: true },
			),
		).toBe(
			[
				"<memory_snapshot>",
				'<project_memory path="/workspace/.pi/tau/memories/PROJECT.md" entries="1" chars="5" limit="2200" usage_percent="0">',
				"alpha",
				"</project_memory>",
				'<global_memory path="/home/test/.pi/agent/tau/memories/MEMORY.md" entries="1" chars="14" limit="2200" usage_percent="0">',
				"beta &amp; &lt;gamma&gt;",
				"</global_memory>",
				'<user_memory path="/home/test/.pi/agent/tau/memories/USER.md" entries="1" chars="3" limit="10" usage_percent="30">',
				"zed",
				"</user_memory>",
				"</memory_snapshot>",
			].join("\n"),
		);
	});

	it("keeps empty scopes in the XML when includeEmpty is true", () => {
		const rendered = renderMemorySnapshotXml(makeSnapshot(), { includeEmpty: true });

		expect(rendered).toContain('<project_memory path="/workspace/.pi/tau/memories/PROJECT.md" entries="0" chars="0" limit="2200" usage_percent="0">');
		expect(rendered).toContain('<global_memory path="/home/test/.pi/agent/tau/memories/MEMORY.md" entries="0" chars="0" limit="2200" usage_percent="0">');
		expect(rendered).toContain('<user_memory path="/home/test/.pi/agent/tau/memories/USER.md" entries="0" chars="0" limit="1375" usage_percent="0">');
	});

	it("floors the usage percentage in XML metadata", () => {
		const entries = ["aa"];
		const rendered = renderMemorySnapshotXml(
			makeSnapshot({
				global: {
					bucket: "global",
					path: "/home/test/.pi/agent/tau/memories/MEMORY.md",
					entries,
					chars: charCount(entries),
					limitChars: 3,
					usagePercent: Math.floor((charCount(entries) / 3) * 100),
				},
			}),
			{ includeEmpty: false },
		);

		expect(rendered).toContain('usage_percent="66"');
	});
});
