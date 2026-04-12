import * as fs from "node:fs";
import * as path from "node:path";

import { Option } from "effect";
import { describe, expect, it } from "vitest";

import { parseAutoresearchTaskDocument } from "../src/autoresearch/task-contract.js";

const SKILL_PATH = path.resolve("skills/autoresearch-create/SKILL.md");

function extractFencedBlock(content: string, language: string): string {
	const marker = `\`\`\`${language}`;
	const start = content.indexOf(marker);
	if (start === -1) {
		throw new Error(`Missing fenced block for ${language}`);
	}
	const afterStart = start + marker.length;
	const end = content.indexOf("```", afterStart);
	if (end === -1) {
		throw new Error(`Unterminated fenced block for ${language}`);
	}
	return content.slice(afterStart, end).trim();
}

describe("autoresearch-create skill", () => {
	it("documents a canonical .pi/loops task example compatible with the task-contract parser", () => {
		const skill = fs.readFileSync(SKILL_PATH, "utf-8");
		const markdownExample = extractFencedBlock(skill, "markdown");
		const contract = parseAutoresearchTaskDocument(
			markdownExample,
			".pi/loops/tasks/sample.md",
		);

		expect(contract.title).toBe("optimize-loop-runtime");
		expect(contract.benchmark.command).toBe("bash scripts/bench.sh");
		expect(
			Option.match(contract.benchmark.checksCommand, {
				onNone: () => null,
				onSome: (value) => value,
			}),
		).toBe("bash scripts/checks.sh");
		expect(contract.metric.name).toBe("total_ms");
		expect(contract.metric.unit).toBe("ms");
		expect(contract.metric.direction).toBe("lower");
		expect(contract.scope.root).toBe("extensions/tau");
		expect(contract.scope.paths).toEqual(["src", "test"]);
		expect(contract.scope.offLimits).toEqual(["dist"]);
		expect(contract.constraints).toEqual(["keep gate green", "no new dependencies"]);
		expect(
			Option.match(contract.limits, {
				onNone: () => null,
				onSome: (value) => value.maxIterations,
			}),
		).toBe(30);
	});

	it("documents current tau-specific Autoresearch requirements", () => {
		const skill = fs.readFileSync(SKILL_PATH, "utf-8");

		expect(skill).toContain("/autoresearch create <task-id> [goal]");
		expect(skill).toContain("Use `autoresearch_run` to execute exactly one trial");
		expect(skill).toContain("Use `autoresearch_done` exactly once to finalize the pending run.");
		expect(skill).toContain("Run artifacts are canonical under `.pi/loops/runs/<task-id>/<run-id>/`.");
		expect(skill).toContain("Legacy cwd-global autoresearch files are not steady-state inputs");
	});
});
