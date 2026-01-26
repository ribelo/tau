import { describe, expect, it } from "vitest";

import { buildAgentContextNotice, injectAgentContextIntoMessages } from "../src/sandbox/agent-awareness/injection.js";
import { isOverlapping } from "../src/sandbox/agent-awareness/detection.js";

describe("agent-awareness", () => {
	it("buildAgentContextNotice: formats 0 and >0", () => {
		expect(buildAgentContextNotice({ count: 0 })).toBe("AGENT_CONTEXT: no other agents detected");
		expect(buildAgentContextNotice({ count: 1 })).toContain("AGENT_CONTEXT: 1 other pi agent detected");
		expect(buildAgentContextNotice({ count: 2 })).toContain("AGENT_CONTEXT: 2 other pi agents detected");
	});

	it("injectAgentContextIntoMessages: prepends last user message", () => {
		const messages = [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hello" },
			{ role: "user", content: "do thing" },
		];

		const out = injectAgentContextIntoMessages(messages, "AGENT_CONTEXT: 1 other pi agent detected");
		expect(out).toHaveLength(3);
		expect(out[2]?.role).toBe("user");
		const content = out[2]?.content;
		expect(Array.isArray(content)).toBe(true);
		const contentArr = content as unknown as Array<{ type: string; text: string }>;
		expect(contentArr[0]?.type).toBe("text");
		expect(contentArr[0]?.text).toContain("AGENT_CONTEXT:");
	});

	it("injectAgentContextIntoMessages: does not double-inject", () => {
		const messages = [
			{
				role: "user",
				content: [{ type: "text", text: "AGENT_CONTEXT: already\n\n" }, { type: "text", text: "do thing" }],
			},
		];

		const out = injectAgentContextIntoMessages(messages as any, "AGENT_CONTEXT: new");
		expect(out).toEqual(messages);
	});

	it("isOverlapping: detects overlap by ancestor and by git root", () => {
		expect(isOverlapping("/repo", null, "/repo/sub")).toBe(true);
		expect(isOverlapping("/repo/sub", null, "/repo")).toBe(true);
		expect(isOverlapping("/repo/a", null, "/repo/b")).toBe(false);

		expect(isOverlapping("/repo/a", "/repo", "/repo/b")).toBe(true);
		expect(isOverlapping("/repo/a", "/repo", "/other")).toBe(false);
	});
});

