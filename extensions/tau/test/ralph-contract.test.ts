import { describe, expect, it } from "vitest";

import {
	makeCapabilityContract,
	makeEmptyCapabilityContract,
	isRalphSystemControlTool,
	excludeRalphSystemControlTools,
	ensureRalphSystemControlTools,
	type RalphCapabilityContract,
} from "../src/ralph/contract.js";

describe("ralph capability contract", () => {
	it("creates an empty contract with version 1", () => {
		const contract = makeEmptyCapabilityContract();
		expect(contract.version).toBe("1");
		expect(contract.tools.activeNames).toEqual([]);
		expect(contract.tools.availableSnapshot).toEqual([]);
		expect(contract.agents.enabledNames).toEqual([]);
		expect(contract.agents.registrySnapshot).toEqual([]);
	});

	it("creates a populated contract from input", () => {
		const contract = makeCapabilityContract({
			toolsActiveNames: ["read", "bash"],
			toolsAvailableSnapshot: [
				{ name: "read", label: "Read", description: "Read files" },
				{ name: "bash", label: "Bash", description: "Run commands" },
			],
			agentsEnabledNames: ["finder", "oracle"],
			agentsRegistrySnapshot: [
				{ name: "finder", description: "Find code" },
				{ name: "oracle", description: "Deep reasoning" },
			],
		});
		expect(contract.version).toBe("1");
		expect(contract.tools.activeNames).toEqual(["read", "bash"]);
		expect(contract.agents.enabledNames).toEqual(["finder", "oracle"]);
	});

	it("identifies ralph_continue and ralph_finish as system control tools", () => {
		expect(isRalphSystemControlTool("ralph_continue")).toBe(true);
		expect(isRalphSystemControlTool("ralph_finish")).toBe(true);
		expect(isRalphSystemControlTool("read")).toBe(false);
		expect(isRalphSystemControlTool("bash")).toBe(false);
	});

	it("excludes system control tools from user-configurable names", () => {
		const names = ["read", "ralph_continue", "bash", "ralph_finish"];
		expect(excludeRalphSystemControlTools(names)).toEqual(["read", "bash"]);
	});

	it("ensures system control tools are present in a names list", () => {
		const names = ["read", "bash"];
		expect(ensureRalphSystemControlTools(names)).toEqual([
			"read",
			"bash",
			"ralph_continue",
			"ralph_finish",
		]);
	});

	it("deduplicates when ensuring system control tools", () => {
		const names = ["read", "ralph_continue", "bash"];
		expect(ensureRalphSystemControlTools(names)).toEqual([
			"read",
			"ralph_continue",
			"bash",
			"ralph_finish",
		]);
	});
});
