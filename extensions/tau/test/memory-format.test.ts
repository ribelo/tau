import { Schema, DateTime } from "effect";
import { describe, expect, it } from "vitest";

import {
	ENTRY_DELIMITER,
	MemoryEntry,
	charCount,
	createMemoryEntry,
	joinEntries,
	migrateLegacyEntries,
	migrateLegacyMarkdownToJsonl,
	normalizeMemoryContent,
	parseMemoryEntries,
	parseEntries,
	renderMemorySnapshotXml,
	serializeMemoryEntries,
	type MemorySnapshot,
} from "../src/memory/format.js";

function parseTimestamp(value: string): typeof Schema.DateTimeUtcFromString.Type {
	return Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(value);
}

function makeSnapshot(partial: Partial<MemorySnapshot> = {}): MemorySnapshot {
	return {
		project: {
			bucket: "project",
			path: "/workspace/.pi/tau/memories/PROJECT.jsonl",
			entries: [],
			chars: 0,
			limitChars: 1000,
			usagePercent: 0,
		},
		global: {
			bucket: "global",
			path: "/home/test/.pi/agent/tau/memories/MEMORY.jsonl",
			entries: [],
			chars: 0,
			limitChars: 1000,
			usagePercent: 0,
		},
		user: {
			bucket: "user",
			path: "/home/test/.pi/agent/tau/memories/USER.jsonl",
			entries: [],
			chars: 0,
			limitChars: 500,
			usagePercent: 0,
		},
		...partial,
	};
}

describe("memory format helpers", () => {
	it("normalizes memory content before validation", () => {
		expect(normalizeMemoryContent("  alpha\r\nbeta  ")).toBe("alpha\nbeta");
	});

	it("creates schema-validated memory entries with nanoid ids and timestamps", () => {
		const createdAt = parseTimestamp("2024-01-02T03:04:05.000Z");
		const updatedAt = parseTimestamp("2024-01-03T04:05:06.000Z");

		const entry = createMemoryEntry("  alpha\r\nbeta  ", {
			id: "123456789012",
			createdAt,
			updatedAt,
		});

		expect(entry).toBeInstanceOf(MemoryEntry);
		expect(entry.id).toBe("123456789012");
		expect(entry.content).toBe("alpha\nbeta");
		expect(DateTime.formatIso(entry.createdAt)).toBe("2024-01-02T03:04:05.000Z");
		expect(DateTime.formatIso(entry.updatedAt)).toBe("2024-01-03T04:05:06.000Z");
	});

	it("serializes and parses JSONL memory entries", () => {
		const first = createMemoryEntry("alpha", {
			id: "123456789012",
			createdAt: parseTimestamp("2024-01-02T03:04:05.000Z"),
			updatedAt: parseTimestamp("2024-01-02T03:04:05.000Z"),
		});
		const second = createMemoryEntry("beta", {
			id: "abcdefghijAB",
			createdAt: parseTimestamp("2024-01-04T03:04:05.000Z"),
			updatedAt: parseTimestamp("2024-01-05T03:04:05.000Z"),
		});

		const raw = serializeMemoryEntries([first, second]);
		expect(raw).toBe(
			[
				JSON.stringify({
					id: "123456789012",
					content: "alpha",
					createdAt: "2024-01-02T03:04:05.000Z",
					updatedAt: "2024-01-02T03:04:05.000Z",
				}),
				JSON.stringify({
					id: "abcdefghijAB",
					content: "beta",
					createdAt: "2024-01-04T03:04:05.000Z",
					updatedAt: "2024-01-05T03:04:05.000Z",
				}),
			].join("\n"),
		);

		const parsed = parseMemoryEntries(raw);
		expect(parsed).toHaveLength(2);
		expect(parsed.map((entry) => entry.id)).toEqual([
			"123456789012",
			"abcdefghijAB",
		]);
		expect(parsed.map((entry) => entry.content)).toEqual(["alpha", "beta"]);
		expect(parsed.map((entry) => DateTime.formatIso(entry.createdAt))).toEqual([
			"2024-01-02T03:04:05.000Z",
			"2024-01-04T03:04:05.000Z",
		]);
	});

	it("rejects invalid JSONL memory entries via Effect Schema validation", () => {
		expect(() =>
			parseMemoryEntries(
				JSON.stringify({
					id: "short-id",
					content: "alpha",
					createdAt: "2024-01-02T03:04:05.000Z",
					updatedAt: "2024-01-02T03:04:05.000Z",
				}),
			),
		).toThrow();

		expect(() =>
			parseMemoryEntries(
				JSON.stringify({
					id: "123456789012",
					content: "   ",
					createdAt: "2024-01-02T03:04:05.000Z",
					updatedAt: "2024-01-02T03:04:05.000Z",
				}),
			),
		).toThrow();
	});

	it("migrates legacy markdown entries into JSONL entries", () => {
		const now = parseTimestamp("2024-01-02T03:04:05.000Z");
		const raw = `first entry${ENTRY_DELIMITER}second entry`;
		let nextId = 0;

		const entries = migrateLegacyEntries(raw, {
			now,
			createId: () => `${++nextId}`.padStart(12, "0"),
		});

		expect(entries.map((entry) => entry.id)).toEqual([
			"000000000001",
			"000000000002",
		]);
		expect(entries.map((entry) => entry.content)).toEqual(["first entry", "second entry"]);
		expect(entries.map((entry) => DateTime.formatIso(entry.createdAt))).toEqual([
			"2024-01-02T03:04:05.000Z",
			"2024-01-02T03:04:05.000Z",
		]);
		expect(migrateLegacyMarkdownToJsonl(raw, {
			now,
			createId: () => "aaaaaaaaAAAA",
		})).toContain('"id":"aaaaaaaaAAAA"');
	});

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
							path: "/workspace/.pi/tau/memories/PROJECT.jsonl",
							entries: projectEntries,
							chars: charCount(projectEntries),
							limitChars: 1000,
							usagePercent: Math.floor((projectEntries[0]!.length / 1000) * 100),
						},
						global: {
							bucket: "global",
							path: "/home/test/.pi/agent/tau/memories/MEMORY.jsonl",
							entries: globalEntries,
							chars: charCount(globalEntries),
							limitChars: 1000,
							usagePercent: Math.floor((globalEntries[0]!.length / 1000) * 100),
						},
						user: {
							bucket: "user",
						path: "/home/test/.pi/agent/tau/memories/USER.jsonl",
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
				'<project_memory path="/workspace/.pi/tau/memories/PROJECT.jsonl" entries="1" chars="5" limit="1000" usage_percent="0">',
				"alpha",
				"</project_memory>",
				'<global_memory path="/home/test/.pi/agent/tau/memories/MEMORY.jsonl" entries="1" chars="14" limit="1000" usage_percent="1">',
				"beta &amp; &lt;gamma&gt;",
				"</global_memory>",
				'<user_memory path="/home/test/.pi/agent/tau/memories/USER.jsonl" entries="1" chars="3" limit="10" usage_percent="30">',
				"zed",
				"</user_memory>",
				"</memory_snapshot>",
			].join("\n"),
		);
	});

	it("keeps empty scopes in the XML when includeEmpty is true", () => {
		const rendered = renderMemorySnapshotXml(makeSnapshot(), { includeEmpty: true });

		expect(rendered).toContain('<project_memory path="/workspace/.pi/tau/memories/PROJECT.jsonl" entries="0" chars="0" limit="1000" usage_percent="0">');
		expect(rendered).toContain('<global_memory path="/home/test/.pi/agent/tau/memories/MEMORY.jsonl" entries="0" chars="0" limit="1000" usage_percent="0">');
		expect(rendered).toContain('<user_memory path="/home/test/.pi/agent/tau/memories/USER.jsonl" entries="0" chars="0" limit="500" usage_percent="0">');
	});

	it("floors the usage percentage in XML metadata", () => {
		const entries = ["aa"];
		const rendered = renderMemorySnapshotXml(
			makeSnapshot({
				global: {
					bucket: "global",
					path: "/home/test/.pi/agent/tau/memories/MEMORY.jsonl",
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
