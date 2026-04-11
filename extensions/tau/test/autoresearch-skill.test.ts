import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { readAutoresearchContractFromContent } from "../src/autoresearch/contract.js";

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
	it("documents an autoresearch.md example compatible with tau's contract parser", () => {
		const skill = fs.readFileSync(SKILL_PATH, "utf-8");
		const markdownExample = extractFencedBlock(skill, "markdown");
		const result = readAutoresearchContractFromContent(markdownExample, SKILL_PATH);

		expect(result.errors).toEqual([]);
		expect(result.contract.benchmark.command).toBe("bash autoresearch.sh");
		expect(result.contract.benchmark.primaryMetric).toBe("<metric_name>");
		expect(result.contract.benchmark.direction).toBe("lower");
		expect(result.contract.scopePaths).toEqual(["<path-one>", "<path-two>"]);
		expect(result.contract.offLimits).toEqual(["<off-limits-path>"]);
		expect(result.contract.constraints).toEqual(["<hard-rule-one>", "<hard-rule-two>"]);
	});

	it("documents current tau-specific Autoresearch requirements", () => {
		const skill = fs.readFileSync(SKILL_PATH, "utf-8");

		expect(skill).toContain("Always include `asi` in `log_experiment`.");
		expect(skill).toContain("`asi.rollback_reason`");
		expect(skill).toContain("`asi.next_action_hint`");
		expect(skill).toContain("Tau pins the execution profile at initialization time.");
		expect(skill).toContain("Tau currently uses its built-in checks timeout");
	});
});
