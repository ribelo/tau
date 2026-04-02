import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition } from "../src/agent/types.js";
import type { ResolvedSandboxConfig } from "../src/sandbox/config.js";

const { createAgentSessionMock, applyAgentToolAllowlistMock, createdSessions } = vi.hoisted(() => ({
	createAgentSessionMock: vi.fn(),
	applyAgentToolAllowlistMock: vi.fn(),
	createdSessions: [] as FakeAgentSession[],
}));

vi.mock("@mariozechner/pi-coding-agent", async () => {
	const actual = await vi.importActual<typeof import("@mariozechner/pi-coding-agent")>(
		"@mariozechner/pi-coding-agent",
	);

	class FakeDefaultResourceLoader {
		async reload(): Promise<void> {}
	}

	return {
		...actual,
		createAgentSession: createAgentSessionMock,
		DefaultResourceLoader: FakeDefaultResourceLoader,
	};
});

vi.mock("../src/agent/tool-allowlist.js", async () => {
	const { Effect } = await import("effect");
	return {
		applyAgentToolAllowlist: (...args: unknown[]) => {
			applyAgentToolAllowlistMock(...args);
			return Effect.void;
		},
		STRUCTURED_OUTPUT_TOOL_NAME: "submit_result",
	};
});

import { AgentWorker, toolOnlyStreamFn } from "../src/agent/worker.js";

type FakeSessionManager = {
	getEntries: () => unknown[];
	appendCustomEntry: (customType: string, data: unknown) => void;
};

class FakeAgentSession {
	readonly sessionId: string;
	readonly sessionManager: FakeSessionManager;
	readonly agent: AgentSession["agent"];
	readonly messages: readonly unknown[] = [];
	readonly isStreaming = false;
	readonly isCompacting = false;

	constructor(id: string, streamFn: AgentSession["agent"]["streamFn"]) {
		this.sessionId = id;
		this.sessionManager = {
			getEntries: () => [],
			appendCustomEntry: () => undefined,
		};
		this.agent = {
			streamFn,
		} as AgentSession["agent"];
	}

	setThinkingLevel(): void {}
	subscribe(): () => void {
		return () => undefined;
	}
	abort(): Promise<void> {
		return Promise.resolve();
	}
}

const TEST_MODEL: Model<Api> = {
	id: "gpt-5.4",
	name: "gpt-5.4",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
};

const TEST_DEFINITION = {
	name: "oracle",
	description: "Oracle worker",
	models: [{ model: "openai-codex/gpt-5.4" }],
	sandbox: { preset: "workspace-write", subagent: true },
	systemPrompt: "You are oracle.",
} satisfies AgentDefinition;

const PARENT_SANDBOX_CONFIG: ResolvedSandboxConfig = {
	preset: "workspace-write",
	filesystemMode: "workspace-write",
	networkMode: "deny",
	approvalPolicy: "on-request",
	approvalTimeoutSeconds: 30,
	subagent: false,
};

const makeModelRegistry = () => ({
	authStorage: {},
	getAll: () => [TEST_MODEL],
});

const makeSession = (index: number): FakeAgentSession => {
	const session = new FakeAgentSession(
		`session-${index}`,
		vi.fn() as AgentSession["agent"]["streamFn"],
	);
	createdSessions.push(session);
	return session;
};

describe("AgentWorker structured-output wiring", () => {
	beforeEach(() => {
		createAgentSessionMock.mockReset();
		applyAgentToolAllowlistMock.mockClear();
		createdSessions.length = 0;
		createAgentSessionMock.mockImplementation(async () => ({
			session: makeSession(createdSessions.length + 1) as unknown as AgentSession,
		}));
	});

	it("installs toolOnlyStreamFn on the created session when structured output is requested", async () => {
		await Effect.runPromise(
			AgentWorker.make({
				definition: TEST_DEFINITION,
				depth: 0,
				cwd: process.cwd(),
				parentSessionId: "parent-session",
				parentSandboxConfig: PARENT_SANDBOX_CONFIG,
				parentModel: TEST_MODEL,
				approvalBroker: undefined,
				modelRegistry: makeModelRegistry() as never,
				resultSchema: { type: "object", properties: { ok: { type: "boolean" } } },
				runPromise: async () => {
					throw new Error("unused");
				},
			}),
		);

		expect(createdSessions).toHaveLength(1);
		expect(createdSessions[0]?.agent.streamFn).toBe(toolOnlyStreamFn);
		expect(applyAgentToolAllowlistMock).toHaveBeenCalledTimes(1);
	});

	it("reinstalls toolOnlyStreamFn after session recreation on model switch", async () => {
		const worker = await Effect.runPromise(
			AgentWorker.make({
				definition: TEST_DEFINITION,
				depth: 0,
				cwd: process.cwd(),
				parentSessionId: "parent-session",
				parentSandboxConfig: PARENT_SANDBOX_CONFIG,
				parentModel: TEST_MODEL,
				approvalBroker: undefined,
				modelRegistry: makeModelRegistry() as never,
				resultSchema: { type: "object", properties: { ok: { type: "boolean" } } },
				runPromise: async () => {
					throw new Error("unused");
				},
			}),
		);

		await Effect.runPromise(
			(worker as unknown as {
				switchToModel: (spec: { model: string }) => Effect.Effect<void, string>;
			}).switchToModel({ model: "openai-codex/gpt-5.4" }),
		);

		expect(createdSessions).toHaveLength(2);
		expect(createdSessions[1]?.agent.streamFn).toBe(toolOnlyStreamFn);
	});
});
