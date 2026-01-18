import { describe, expect, it } from "vitest";

import { detectMissingSandboxDeps } from "../src/sandbox-prereqs.js";

describe("detectMissingSandboxDeps", () => {
	it("linux: reports missing bwrap/socat/python3", () => {
		const res = detectMissingSandboxDeps({
			platform: "linux",
			commandExists: () => false,
		});
		expect(res.missingRequired).toEqual(["bwrap", "socat", "python3"]);
	});

	it("darwin: reports missing sandbox-exec and optional rg", () => {
		const res = detectMissingSandboxDeps({
			platform: "darwin",
			commandExists: (cmd) => cmd !== "sandbox-exec" && cmd !== "rg",
		});
		expect(res.missingRequired).toEqual(["sandbox-exec"]);
		expect(res.missingOptional).toEqual(["rg"]);
	});

	it("other platforms: reports no deps (sandbox may still be unavailable)", () => {
		const res = detectMissingSandboxDeps({
			platform: "win32" as any,
			commandExists: () => false,
		});
		expect(res.missingRequired).toEqual([]);
		expect(res.missingOptional).toEqual([]);
	});
});
