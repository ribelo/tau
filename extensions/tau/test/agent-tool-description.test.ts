import { describe, expect, it } from "vitest";

import { buildToolDescription } from "../src/agent/tool.js";

function makeRegistry(agents: ReadonlyArray<{ name: string; description: string }>) {
	return { list: () => agents };
}

const agents = [
	{ name: "smart", description: "Smart agent.\nGeneral purpose." },
	{ name: "oracle", description: "Expert reasoning agent." },
	{ name: "finder", description: "Fast code search agent." },
];

describe("buildToolDescription", () => {
	it("lists all agents when no isDisabled predicate is given", () => {
		const desc = buildToolDescription(makeRegistry(agents));
		expect(desc).toContain("- smart:");
		expect(desc).toContain("- oracle:");
		expect(desc).toContain("- finder:");
	});

	it("lists all agents when isDisabled returns false for every agent", () => {
		const desc = buildToolDescription(makeRegistry(agents), undefined, () => false);
		expect(desc).toContain("- smart:");
		expect(desc).toContain("- oracle:");
		expect(desc).toContain("- finder:");
	});

	it("excludes disabled agents entirely from description", () => {
		const disabled = new Set(["oracle"]);
		const desc = buildToolDescription(makeRegistry(agents), undefined, (n) => disabled.has(n));

		expect(desc).toContain("- smart:");
		expect(desc).toContain("- finder:");
		expect(desc).not.toContain("oracle");
	});

	it("excludes multiple disabled agents", () => {
		const disabled = new Set(["smart", "finder"]);
		const desc = buildToolDescription(makeRegistry(agents), undefined, (n) => disabled.has(n));

		expect(desc).toContain("- oracle:");
		expect(desc).not.toContain("smart");
		expect(desc).not.toContain("finder");
	});

	it("uses only first line of multi-line description", () => {
		const desc = buildToolDescription(makeRegistry(agents));
		expect(desc).toContain("- smart: Smart agent.");
		expect(desc).not.toContain("General purpose");
	});

	it("respects spawns filter combined with isDisabled", () => {
		const disabled = new Set(["oracle"]);
		const desc = buildToolDescription(
			makeRegistry(agents),
			["smart", "oracle"],
			(n) => disabled.has(n),
		);

		expect(desc).toContain("- smart:");
		expect(desc).not.toContain("oracle");
		expect(desc).not.toContain("finder");
	});

	it("shows no agent entries when all are disabled", () => {
		const desc = buildToolDescription(makeRegistry(agents), undefined, () => true);

		expect(desc).toContain("Available agents");
		expect(desc).not.toContain("- smart:");
		expect(desc).not.toContain("- oracle:");
		expect(desc).not.toContain("- finder:");
	});
});
