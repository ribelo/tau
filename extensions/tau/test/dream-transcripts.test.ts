import { describe, expect, it } from "vitest";

import {
	dreamTranscriptRoot,
	isDreamTranscriptFile,
	parseDreamTranscriptSessionId,
} from "../src/dream/transcripts.js";

function withPiAgentDirEnv(value: string | undefined, fn: () => void): void {
	const previous = process.env["PI_CODING_AGENT_DIR"];
	if (value === undefined) {
		delete process.env["PI_CODING_AGENT_DIR"];
	} else {
		process.env["PI_CODING_AGENT_DIR"] = value;
	}

	try {
		fn();
	} finally {
		if (previous === undefined) {
			delete process.env["PI_CODING_AGENT_DIR"];
		} else {
			process.env["PI_CODING_AGENT_DIR"] = previous;
		}
	}
}

describe("dream transcript helpers", () => {
	it("accepts persisted pi session transcript files", () => {
		expect(isDreamTranscriptFile("2026-04-03T00-00-00.000Z_session-1.jsonl")).toBe(true);
		expect(isDreamTranscriptFile("session-1.json")).toBe(false);
	});

	it("extracts the session id from a persisted transcript path", () => {
		expect(
			parseDreamTranscriptSessionId("/workspace/.pi/sessions/2026-04-03T00-00-00.000Z_session-1.jsonl"),
		).toBe("session-1");
	});

	it("uses pi's global session directory layout", () => {
		expect(dreamTranscriptRoot("/workspace/project")).toContain(".pi/agent/sessions/");
		expect(dreamTranscriptRoot("/workspace/project")).toContain("--workspace-project--");
	});

	it("respects the PI_CODING_AGENT_DIR override", () => {
		withPiAgentDirEnv("/tmp/custom-agent", () => {
			expect(dreamTranscriptRoot("/workspace/project")).toContain("/tmp/custom-agent/sessions/");
		});
	});

	it("rejects invalid transcript file names", () => {
		expect(parseDreamTranscriptSessionId("/workspace/.pi/sessions/session-1.jsonl")).toBeNull();
	});
});
