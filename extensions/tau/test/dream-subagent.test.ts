import { DateTime, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@mariozechner/pi-agent-core";

import {
	_formatMemorySnapshotForPrompt as formatMemorySnapshotForPrompt,
	_createTurnLimitGuard as createTurnLimitGuard,
	_stripCodeFences as stripCodeFences,
	_isAssistantMessage as isAssistantMessage,
} from "../src/dream/subagent.js";
import { DreamConsolidationPlan } from "../src/dream/domain.js";
import { createMemoryEntry, type MemoryEntriesSnapshot, type MemoryBucketEntriesSnapshot } from "../src/memory/format.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEntry(id: string, scope: "project" | "global" | "user", content: string) {
	return createMemoryEntry(content, {
		id,
		scope,
		now: DateTime.makeUnsafe("2025-01-01T00:00:00Z"),
	});
}

function makeBucket(
	bucket: "project" | "global" | "user",
	entries: ReturnType<typeof makeEntry>[] = [],
	limitChars = 2048,
): MemoryBucketEntriesSnapshot {
	const chars = entries.reduce((sum, e) => sum + e.content.length, 0);
	return {
		bucket,
		path: `/fake/.pi/tau/memories/${bucket.toUpperCase()}.jsonl`,
		entries,
		chars,
		limitChars,
		usagePercent: Math.round((chars / limitChars) * 100),
	};
}

function makeSnapshot(
	overrides: Partial<Record<"project" | "global" | "user", ReturnType<typeof makeEntry>[]>> = {},
): MemoryEntriesSnapshot {
	return {
		project: makeBucket("project", overrides.project ?? []),
		global: makeBucket("global", overrides.global ?? []),
		user: makeBucket("user", overrides.user ?? [], 1024),
	};
}

// ---------------------------------------------------------------------------
// stripCodeFences
// ---------------------------------------------------------------------------

describe("stripCodeFences", () => {
	it("passes through plain JSON", () => {
		const json = '{"summary":"test","reviewedSessions":[],"pruneNotes":[],"operations":[]}';
		expect(stripCodeFences(json)).toBe(json);
	});

	it("strips ```json fences", () => {
		const wrapped = '```json\n{"a":1}\n```';
		expect(stripCodeFences(wrapped)).toBe('{"a":1}');
	});

	it("strips plain ``` fences", () => {
		const wrapped = '```\n{"a":1}\n```';
		expect(stripCodeFences(wrapped)).toBe('{"a":1}');
	});

	it("trims leading/trailing whitespace", () => {
		expect(stripCodeFences("  \n  {}\n  ")).toBe("{}");
	});
});

// ---------------------------------------------------------------------------
// isAssistantMessage
// ---------------------------------------------------------------------------

describe("isAssistantMessage", () => {
	it("accepts an object with role=assistant and array content", () => {
		expect(
			isAssistantMessage({
				role: "assistant",
				content: [{ type: "text", text: "hello" }],
			}),
		).toBe(true);
	});

	it("rejects a user message", () => {
		expect(isAssistantMessage({ role: "user", content: [] })).toBe(false);
	});

	it("rejects null", () => {
		expect(isAssistantMessage(null)).toBe(false);
	});

	it("rejects missing content", () => {
		expect(isAssistantMessage({ role: "assistant" })).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// turn limit guard
// ---------------------------------------------------------------------------

describe("createTurnLimitGuard", () => {
	it("treats the first dream turn as already started and aborts before the next turn would exceed maxTurns", async () => {
		const listeners: Array<(event: AgentEvent) => void> = [];
		let aborts = 0;
		const turnStartEvent = { type: "turn_start" } as unknown as AgentEvent;

		const guard = createTurnLimitGuard(
			{
				agent: {
					subscribe: (listener) => {
						listeners.push(listener);
						return () => undefined;
					},
				},
				abort: async () => {
					aborts += 1;
				},
			},
			2,
		);

		listeners[0]?.(turnStartEvent);
		expect(aborts).toBe(0);

		listeners[0]?.(turnStartEvent);

		await expect(guard.promise).resolves.toEqual({
			_tag: "turn_limit_exceeded",
			maxTurns: 2,
		});
		expect(aborts).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// formatMemorySnapshotForPrompt
// ---------------------------------------------------------------------------

describe("formatMemorySnapshotForPrompt", () => {
	it("formats an empty snapshot", () => {
		const text = formatMemorySnapshotForPrompt(makeSnapshot());
		expect(text).toContain("(empty)");
		expect(text).toContain("### project");
		expect(text).toContain("### global");
		expect(text).toContain("### user");
	});

	it("includes entry ids and content", () => {
		const entry = makeEntry("abc123456789", "project", "Some durable fact");
		const text = formatMemorySnapshotForPrompt(
			makeSnapshot({ project: [entry] }),
		);
		expect(text).toContain("[abc123456789]");
		expect(text).toContain("Some durable fact");
	});

	it("includes usage stats", () => {
		const text = formatMemorySnapshotForPrompt(makeSnapshot());
		expect(text).toContain("0/2048 chars");
		expect(text).toContain("0/1024 chars");
	});
});

// ---------------------------------------------------------------------------
// DreamConsolidationPlan schema decoding
// ---------------------------------------------------------------------------

describe("DreamConsolidationPlan schema", () => {
	const decode = Schema.decodeUnknownSync(DreamConsolidationPlan);

	it("decodes a valid plan with all operation types", () => {
		const plan = decode({
			summary: "Consolidated 3 sessions",
			reviewedSessions: ["sess-1", "sess-2"],
			pruneNotes: ["Removed stale entry"],
			operations: [
				{
					_tag: "add",
					scope: "project",
					content: "New fact",
					rationale: "Learned from session",
				},
				{
					_tag: "update",
					scope: "global",
					id: "abc123456789",
					content: "Updated fact",
					rationale: "Corrected detail",
				},
				{
					_tag: "remove",
					scope: "user",
					id: "def456789012",
					rationale: "No longer relevant",
				},
			],
		});

		expect(plan.summary).toBe("Consolidated 3 sessions");
		expect(plan.reviewedSessions).toEqual(["sess-1", "sess-2"]);
		expect(plan.operations).toHaveLength(3);
		expect(plan.operations[0]!._tag).toBe("add");
		expect(plan.operations[1]!._tag).toBe("update");
		expect(plan.operations[2]!._tag).toBe("remove");
	});

	it("decodes an empty plan", () => {
		const plan = decode({
			summary: "No changes needed",
			reviewedSessions: [],
			pruneNotes: [],
			operations: [],
		});
		expect(plan.operations).toEqual([]);
	});

	it("rejects an invalid scope", () => {
		expect(() =>
			decode({
				summary: "Bad",
				reviewedSessions: [],
				pruneNotes: [],
				operations: [
					{
						_tag: "add",
						scope: "invalid",
						content: "x",
						rationale: "y",
					},
				],
			}),
		).toThrow();
	});

	it("rejects a missing summary", () => {
		expect(() =>
			decode({
				reviewedSessions: [],
				pruneNotes: [],
				operations: [],
			}),
		).toThrow();
	});

	it("rejects an invalid operation tag", () => {
		expect(() =>
			decode({
				summary: "Bad",
				reviewedSessions: [],
				pruneNotes: [],
				operations: [
					{
						_tag: "merge",
						scope: "project",
						content: "x",
						rationale: "y",
					},
				],
			}),
		).toThrow();
	});
});
