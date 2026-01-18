import { describe, expect, it } from "vitest";

import { classifySandboxFailure } from "../src/sandbox-diagnostics.js";

describe("classifySandboxFailure", () => {
	it("classifies explicit allowlist block as network/blocked (high)", () => {
		const out = "Error: connection blocked by network allowlist (example.org)";
		expect(classifySandboxFailure(out)).toEqual({
			kind: "network",
			subtype: "blocked",
			confidence: "high",
			evidence: "Error: connection blocked by network allowlist (example.org)",
		});
	});

	it("classifies DNS errors as network/dns (medium)", () => {
		const out = "curl: (6) Could not resolve host: example.com";
		expect(classifySandboxFailure(out)).toMatchObject({
			kind: "network",
			subtype: "dns",
			confidence: "medium",
		});
	});

	it("classifies EAI_AGAIN as network/dns (medium)", () => {
		const out = "getaddrinfo EAI_AGAIN registry.npmjs.org";
		expect(classifySandboxFailure(out)).toMatchObject({
			kind: "network",
			subtype: "dns",
			confidence: "medium",
		});
	});

	it("classifies read-only/permission errors as filesystem/write (high)", () => {
		const out = "cp: cannot create regular file 'x': Read-only file system";
		expect(classifySandboxFailure(out)).toMatchObject({
			kind: "filesystem",
			subtype: "write",
			confidence: "high",
		});
	});

	it("returns unknown for unrelated failures", () => {
		const out = "SyntaxError: Unexpected token";
		expect(classifySandboxFailure(out)).toMatchObject({
			kind: "unknown",
			confidence: "low",
		});
	});
});
