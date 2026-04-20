import { Schema, DateTime } from "effect";
import { describe, expect, it } from "vitest";

import {
	ENTRY_DELIMITER,
	MemoryEntry,
	charCount,
	createMemoryEntry,
	findMemoryRepairIssues,
	joinEntries,
	makeMemoryIndex,
	memorySummaryMatchesContent,
	migrateLegacyEntries,
	migrateLegacyMarkdownToJsonl,
	normalizeMemoryContent,
	normalizeMemorySummary,
	parseMemoryEntries,
	parseMemoryEntriesWithMigration,
	parseEntries,
	renderMemoryIndexXml,
	renderMemorySnapshotXml,
	serializeMemoryEntries,
	type MemoryEntriesSnapshot,
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
			limitChars: 25000,
			usagePercent: 0,
		},
		global: {
			bucket: "global",
			path: "/home/test/.pi/agent/tau/memories/MEMORY.jsonl",
			entries: [],
			chars: 0,
			limitChars: 25000,
			usagePercent: 0,
		},
		user: {
			bucket: "user",
			path: "/home/test/.pi/agent/tau/memories/USER.jsonl",
			entries: [],
			chars: 0,
			limitChars: 25000,
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
			scope: "project",
			type: "preference",
			summary: "alpha beta hook",
			createdAt,
			updatedAt,
		});

		expect(entry).toBeInstanceOf(MemoryEntry);
		expect(entry.id).toBe("123456789012");
		expect(entry.scope).toBe("project");
		expect(entry.type).toBe("preference");
		expect(entry.summary).toBe("alpha beta hook");
		expect(entry.content).toBe("alpha\nbeta");
		expect(DateTime.formatIso(entry.createdAt)).toBe("2024-01-02T03:04:05.000Z");
		expect(DateTime.formatIso(entry.updatedAt)).toBe("2024-01-03T04:05:06.000Z");
	});

	it("serializes and parses JSONL memory entries", () => {
		const first = createMemoryEntry("alpha", {
			id: "123456789012",
			scope: "project",
			type: "fact",
			summary: "alpha hook",
			createdAt: parseTimestamp("2024-01-02T03:04:05.000Z"),
			updatedAt: parseTimestamp("2024-01-02T03:04:05.000Z"),
		});
		const second = createMemoryEntry("beta", {
			id: "abcdefghijAB",
			scope: "global",
			type: "constraint",
			summary: "beta hook",
			createdAt: parseTimestamp("2024-01-04T03:04:05.000Z"),
			updatedAt: parseTimestamp("2024-01-05T03:04:05.000Z"),
		});

		const raw = serializeMemoryEntries([first, second]);
		expect(raw).toBe(
			[
				JSON.stringify({
					id: "123456789012",
					scope: "project",
					type: "fact",
					summary: "alpha hook",
					content: "alpha",
					createdAt: "2024-01-02T03:04:05.000Z",
					updatedAt: "2024-01-02T03:04:05.000Z",
				}),
				JSON.stringify({
					id: "abcdefghijAB",
					scope: "global",
					type: "constraint",
					summary: "beta hook",
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
		expect(parsed.map((entry) => entry.scope)).toEqual(["project", "global"]);
		expect(parsed.map((entry) => entry.type)).toEqual(["fact", "constraint"]);
		expect(parsed.map((entry) => entry.summary)).toEqual(["alpha hook", "beta hook"]);
		expect(parsed.map((entry) => entry.content)).toEqual(["alpha", "beta"]);
		expect(parsed.map((entry) => DateTime.formatIso(entry.createdAt))).toEqual([
			"2024-01-02T03:04:05.000Z",
			"2024-01-04T03:04:05.000Z",
		]);
	});

	it("migrates legacy JSONL entries missing scope/type/summary", () => {
		const parsed = parseMemoryEntries(
			JSON.stringify({
				id: "itoVz1h0QCl_78gmCgjPG",
				content: "alpha",
				createdAt: "2024-01-02T03:04:05.000Z",
				updatedAt: "2024-01-02T03:04:05.000Z",
			}),
			{ scope: "user" },
		);

		expect(parsed).toHaveLength(1);
		expect(parsed[0]?.id).toBe("itoVz1h0QCl_78gmCgjPG");
		expect(parsed[0]?.scope).toBe("user");
		expect(parsed[0]?.type).toBe("fact");
		expect(parsed[0]?.summary).toBe("alpha");
		expect(parsed[0]?.content).toBe("alpha");
	});

	it("reports migration when parsed entries are normalized to canonical shape", () => {
		const parsed = parseMemoryEntriesWithMigration(
			JSON.stringify({
				id: "123456789012",
				content: "  alpha\n beta  ",
				createdAt: "2024-01-02T03:04:05.000Z",
				updatedAt: "2024-01-02T03:04:05.000Z",
			}),
			{ scope: "project", defaultType: "context" },
		);

		expect(parsed.migrated).toBe(true);
		expect(parsed.entries[0]?.scope).toBe("project");
		expect(parsed.entries[0]?.type).toBe("context");
		expect(parsed.entries[0]?.summary).toBe("alpha beta");
		expect(parsed.entries[0]?.content).toBe("alpha\n beta");
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
			scope: "project",
			type: "workflow",
			createId: () => `${++nextId}`.padStart(12, "0"),
		});

		expect(entries.map((entry) => entry.id)).toEqual([
			"000000000001",
			"000000000002",
		]);
		expect(entries.map((entry) => entry.content)).toEqual(["first entry", "second entry"]);
		expect(entries.map((entry) => entry.scope)).toEqual(["project", "project"]);
		expect(entries.map((entry) => entry.type)).toEqual(["workflow", "workflow"]);
		expect(entries.map((entry) => entry.summary)).toEqual(["first entry", "second entry"]);
		expect(entries.map((entry) => DateTime.formatIso(entry.createdAt))).toEqual([
			"2024-01-02T03:04:05.000Z",
			"2024-01-02T03:04:05.000Z",
		]);
		expect(migrateLegacyMarkdownToJsonl(raw, {
			now,
			scope: "global",
			type: "constraint",
			createId: () => "aaaaaaaaAAAA",
		})).toContain('"type":"constraint"');
	});

	it("derives compact summaries from full content", () => {
		expect(normalizeMemorySummary("  alpha\n\n beta\n gamma  ")).toBe("alpha beta gamma");
		expect(normalizeMemorySummary("x".repeat(180))).toHaveLength(140);
	});

	it("detects when a summary duplicates the full content body", () => {
		expect(memorySummaryMatchesContent("alpha beta", "alpha\n beta")).toBe(true);
		expect(memorySummaryMatchesContent("alpha hook", "alpha\n beta")).toBe(false);
	});

	it("rejects new entries whose summary duplicates content", () => {
		expect(() =>
			createMemoryEntry("alpha\nbeta", {
				summary: "alpha beta",
			}),
		).toThrow("memory summary must not duplicate full content");
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
							limitChars: 25000,
							usagePercent: Math.floor((charCount(projectEntries) / 25000) * 100),
						},
						global: {
							bucket: "global",
							path: "/home/test/.pi/agent/tau/memories/MEMORY.jsonl",
							entries: globalEntries,
							chars: charCount(globalEntries),
							limitChars: 25000,
							usagePercent: Math.floor((charCount(globalEntries) / 25000) * 100),
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
				'<project_memory path="/workspace/.pi/tau/memories/PROJECT.jsonl" entries="1" chars="5" limit="25000" usage_percent="0">',
				"alpha",
				"</project_memory>",
				'<global_memory path="/home/test/.pi/agent/tau/memories/MEMORY.jsonl" entries="1" chars="14" limit="25000" usage_percent="0">',
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

		expect(rendered).toContain('<project_memory path="/workspace/.pi/tau/memories/PROJECT.jsonl" entries="0" chars="0" limit="25000" usage_percent="0">');
		expect(rendered).toContain('<global_memory path="/home/test/.pi/agent/tau/memories/MEMORY.jsonl" entries="0" chars="0" limit="25000" usage_percent="0">');
		expect(rendered).toContain('<user_memory path="/home/test/.pi/agent/tau/memories/USER.jsonl" entries="0" chars="0" limit="25000" usage_percent="0">');
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

describe("memory index rendering", () => {
	function makeEntriesSnapshot(): MemoryEntriesSnapshot {
		const createdAt = parseTimestamp("2024-01-02T03:04:05.000Z");
		const updatedAt = parseTimestamp("2024-01-02T03:04:05.000Z");

		return {
			project: {
				bucket: "project",
				path: "/workspace/.pi/tau/memories/PROJECT.jsonl",
				entries: [
					createMemoryEntry("project content alpha", {
						id: "proj12345678",
						scope: "project",
						type: "fact",
						summary: "project alpha hook",
						createdAt,
						updatedAt,
					}),
				],
				chars: 100,
				limitChars: 25000,
				usagePercent: 5,
			},
			global: {
				bucket: "global",
				path: "/home/test/.pi/agent/tau/memories/MEMORY.jsonl",
				entries: [
					createMemoryEntry("global preference beta", {
						id: "glob12345678",
						scope: "global",
						type: "preference",
						summary: "global beta hook",
						createdAt,
						updatedAt,
					}),
				],
				chars: 100,
				limitChars: 25000,
				usagePercent: 5,
			},
			user: {
				bucket: "user",
				path: "/home/test/.pi/agent/tau/memories/USER.jsonl",
				entries: [
					createMemoryEntry("user context gamma", {
						id: "user12345678",
						scope: "user",
						type: "context",
						summary: "user gamma hook",
						createdAt,
						updatedAt,
					}),
				],
				chars: 50,
				limitChars: 25000,
				usagePercent: 5,
			},
		};
	}

	it("creates a memory index from entries snapshot", () => {
		const snapshot = makeEntriesSnapshot();
		const index = makeMemoryIndex(snapshot);

		expect(index.project).toHaveLength(1);
		expect(index.project[0]).toEqual({
			id: "proj12345678",
			scope: "project",
			type: "fact",
			summary: "project alpha hook",
		});

		expect(index.global).toHaveLength(1);
		expect(index.global[0]).toEqual({
			id: "glob12345678",
			scope: "global",
			type: "preference",
			summary: "global beta hook",
		});

		expect(index.user).toHaveLength(1);
		expect(index.user[0]).toEqual({
			id: "user12345678",
			scope: "user",
			type: "context",
			summary: "user gamma hook",
		});
	});

	it("renders an empty memory index when all scopes are empty", () => {
		const emptySnapshot: MemoryEntriesSnapshot = {
			project: { bucket: "project", path: "", entries: [], chars: 0, limitChars: 25000, usagePercent: 0 },
			global: { bucket: "global", path: "", entries: [], chars: 0, limitChars: 25000, usagePercent: 0 },
			user: { bucket: "user", path: "", entries: [], chars: 0, limitChars: 25000, usagePercent: 0 },
		};
		const index = makeMemoryIndex(emptySnapshot);
		const rendered = renderMemoryIndexXml(index);

		expect(rendered).toBe("");
	});

	it("renders memory index with entry id, scope, type, and summary", () => {
		const snapshot = makeEntriesSnapshot();
		const index = makeMemoryIndex(snapshot);
		const rendered = renderMemoryIndexXml(index);

		expect(rendered).toContain('<memory_index>');
		expect(rendered).toContain('</memory_index>');
		expect(rendered).toContain('<project_memory>');
		expect(rendered).toContain('</project_memory>');
		expect(rendered).toContain('<global_memory>');
		expect(rendered).toContain('</global_memory>');
		expect(rendered).toContain('<user_memory>');
		expect(rendered).toContain('</user_memory>');

		// Check entry format
		expect(rendered).toContain('<entry id="proj12345678" scope="project" type="fact">project alpha hook</entry>');
		expect(rendered).toContain('<entry id="glob12345678" scope="global" type="preference">global beta hook</entry>');
		expect(rendered).toContain('<entry id="user12345678" scope="user" type="context">user gamma hook</entry>');
	});

	it("escapes special XML characters in index entries", () => {
		const createdAt = parseTimestamp("2024-01-02T03:04:05.000Z");
		const updatedAt = parseTimestamp("2024-01-02T03:04:05.000Z");
		const snapshot: MemoryEntriesSnapshot = {
			project: {
				bucket: "project",
				path: "/workspace/.pi/tau/memories/PROJECT.jsonl",
				entries: [
					createMemoryEntry("content with <special> & \"chars\"", {
						id: "test12345678",
						scope: "project",
						type: "fact",
						summary: "summary with <special> & \"chars\"",
						createdAt,
						updatedAt,
					}),
				],
				chars: 50,
				limitChars: 25000,
				usagePercent: 2,
			},
			global: { bucket: "global", path: "", entries: [], chars: 0, limitChars: 25000, usagePercent: 0 },
			user: { bucket: "user", path: "", entries: [], chars: 0, limitChars: 25000, usagePercent: 0 },
		};

		const index = makeMemoryIndex(snapshot);
		const rendered = renderMemoryIndexXml(index);

		expect(rendered).toContain('&lt;special&gt;');
		expect(rendered).toContain('&amp;');
		expect(rendered).toContain('&quot;chars&quot;');
		expect(rendered).not.toContain('<special>');
	});

	it("omits empty scopes from memory index", () => {
		const createdAt = parseTimestamp("2024-01-02T03:04:05.000Z");
		const updatedAt = parseTimestamp("2024-01-02T03:04:05.000Z");
		const snapshot: MemoryEntriesSnapshot = {
			project: { bucket: "project", path: "", entries: [], chars: 0, limitChars: 25000, usagePercent: 0 },
			global: {
				bucket: "global",
				path: "/home/test/.pi/agent/tau/memories/MEMORY.jsonl",
				entries: [
					createMemoryEntry("only global entry", {
						id: "glob12345678",
						scope: "global",
						type: "fact",
						summary: "global entry hook",
						createdAt,
						updatedAt,
					}),
				],
				chars: 50,
				limitChars: 25000,
				usagePercent: 2,
			},
			user: { bucket: "user", path: "", entries: [], chars: 0, limitChars: 25000, usagePercent: 0 },
		};

		const index = makeMemoryIndex(snapshot);
		const rendered = renderMemoryIndexXml(index);

		expect(rendered).toContain('<memory_index>');
		expect(rendered).toContain('<global_memory>');
		expect(rendered).not.toContain('<project_memory>');
		expect(rendered).not.toContain('<user_memory>');
	});

	it("finds persisted entries that need summary repair", () => {
		const invalid = {
			...createMemoryEntry("valid content", {
				summary: "valid hook",
			}),
			summary: "valid content",
		};
		const issues = findMemoryRepairIssues({
			project: { bucket: "project", path: "", entries: [invalid], chars: invalid.content.length, limitChars: 25000, usagePercent: 1 },
			global: { bucket: "global", path: "", entries: [], chars: 0, limitChars: 25000, usagePercent: 0 },
			user: { bucket: "user", path: "", entries: [], chars: 0, limitChars: 25000, usagePercent: 0 },
		});

		expect(issues).toEqual([
			{
				id: invalid.id,
				scope: "global",
				summary: "valid content",
				content: "valid content",
				reason: "summary_matches_content",
			},
		]);
	});

	it("omits repair-needed entries from the prompt memory index", () => {
		const invalid = {
			...createMemoryEntry("valid content", {
				summary: "valid hook",
			}),
			summary: "valid content",
		};
		const index = makeMemoryIndex({
			project: { bucket: "project", path: "", entries: [invalid], chars: invalid.content.length, limitChars: 25000, usagePercent: 1 },
			global: { bucket: "global", path: "", entries: [], chars: 0, limitChars: 25000, usagePercent: 0 },
			user: { bucket: "user", path: "", entries: [], chars: 0, limitChars: 25000, usagePercent: 0 },
		});

		expect(index.project).toEqual([]);
		expect(renderMemoryIndexXml(index)).toBe("");
	});
});
