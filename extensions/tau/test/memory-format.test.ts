import { describe, expect, it } from "vitest";

import {
	ENTRY_DELIMITER,
	charCount,
	joinEntries,
	parseEntries,
	renderPromptBlock,
} from "../src/memory/format.js";

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

	it("renders an empty prompt block when there are no entries", () => {
		expect(renderPromptBlock("memory", [], 2200)).toBe("");
	});

	it("renders a memory prompt block with usage and content", () => {
		const entries = ["alpha", "beta\ngamma"];
		const expectedContent = `alpha${ENTRY_DELIMITER}beta\ngamma`;
		const expectedChars = expectedContent.length;

		expect(renderPromptBlock("memory", entries, 20)).toBe(
			[
				"═".repeat(46),
				`MEMORY (your personal notes) [${Math.floor((expectedChars / 20) * 100)}% — ${expectedChars}/20 chars]`,
				"═".repeat(46),
				expectedContent,
			].join("\n"),
		);
	});

	it("renders a user profile prompt block with grouped numbers", () => {
		const entry = "x".repeat(1474);

		expect(renderPromptBlock("user", [entry], 2200)).toContain(
			"USER PROFILE (who the user is) [67% — 1,474/2,200 chars]",
		);
	});

	it("floors the usage percentage", () => {
		expect(renderPromptBlock("memory", ["aa"], 3)).toContain("[66% — 2/3 chars]");
	});
});
