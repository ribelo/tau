import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ModelRegistry,
} from "@mariozechner/pi-coding-agent";

import { createIssue } from "../src/backlog/events.js";
import initForge from "../src/forge/index.js";
import { loadState, saveState } from "../src/forge/state.js";
import type { ForgeState } from "../src/forge/types.js";

type RegisteredCommand = {
	readonly handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
};

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

type ModelRef = {
	readonly provider: string;
	readonly id: string;
	readonly name: string;
};

type PiStub = {
	readonly pi: ExtensionAPI;
	readonly commands: Map<string, RegisteredCommand>;
	readonly sentMessages: string[];
	readonly setModelCalls: string[];
};

function modelId(model: { readonly provider: string; readonly id: string }): string {
	return `${model.provider}/${model.id}`;
}

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tau-forge-"));
}

function makeContext(
	cwd: string,
	model: ModelRef,
	modelRegistry: ModelRegistry,
): ExtensionCommandContext {
	return {
		cwd,
		hasUI: true,
		model,
		modelRegistry,
		sessionManager: {
			getEntries: () => [],
			getBranch: () => [],
			getSessionId: () => "test-session",
		},
		ui: {
			setStatus: () => undefined,
			setWidget: () => undefined,
			setFooter: () => () => undefined,
			setEditorComponent: () => undefined,
			notify: () => undefined,
			getEditorText: () => "",
			theme: {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			},
		},
		isIdle: () => true,
		abort: () => undefined,
		hasPendingMessages: () => false,
		shutdown: () => undefined,
		getContextUsage: () => undefined,
		compact: () => undefined,
		getSystemPrompt: () => "",
		waitForIdle: async () => undefined,
		newSession: async () => ({ cancelled: false }),
		fork: async () => ({ cancelled: false }),
		navigateTree: async () => ({ cancelled: false }),
		switchSession: async () => ({ cancelled: false }),
		reload: async () => undefined,
	} as unknown as ExtensionCommandContext;
}

function makePiStub(
	context: ExtensionCommandContext,
	responses: readonly string[],
): PiStub {
	const eventHandlers = new Map<string, EventHandler[]>();
	const commands = new Map<string, RegisteredCommand>();
	const sentMessages: string[] = [];
	const setModelCalls: string[] = [];
	let responseIndex = 0;
	let activeTools = ["read", "bash", "edit", "write", "backlog", "agent", "git_commit_with_user_approval"];

	const fire = async (event: string, payload: unknown, ctx?: ExtensionContext): Promise<void> => {
		for (const handler of eventHandlers.get(event) ?? []) {
			await Promise.resolve(handler(payload, ctx ?? context));
		}
	};

	const base = {
		on: (event: string, handler: EventHandler) => {
			const handlers = eventHandlers.get(event) ?? [];
			handlers.push(handler);
			eventHandlers.set(event, handlers);
		},
		registerCommand: (name: string, command: RegisteredCommand) => {
			commands.set(name, command);
		},
		registerTool: () => undefined,
		registerShortcut: () => undefined,
		registerFlag: () => undefined,
		registerMessageRenderer: () => undefined,
		getActiveTools: () => activeTools,
		setActiveTools: (toolNames: string[]) => {
			activeTools = [...toolNames];
		},
		getAllTools: () => [],
		getCommands: () => [],
		setModel: async (model: unknown) => {
			if (
				typeof model === "object" &&
				model !== null &&
				"provider" in model &&
				"id" in model &&
				typeof model.provider === "string" &&
				typeof model.id === "string"
			) {
				setModelCalls.push(`${model.provider}/${model.id}`);
				return true;
			}
			return false;
		},
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => undefined,
		sendUserMessage: (message: string) => {
			sentMessages.push(message);
			const response = responses[responseIndex] ?? "";
			responseIndex += 1;
			queueMicrotask(async () => {
				await fire(
					"agent_end",
					{
						type: "agent_end",
						messages: [
							{
								role: "assistant",
								content: [{ type: "text", text: response }],
							},
						],
					},
					context,
				);
			});
		},
		appendEntry: () => undefined,
		sendMessage: () => undefined,
		events: {
			emit: () => undefined,
			on: () => () => undefined,
		},
	};

	return {
		pi: new Proxy(base, {
			get(target, prop, receiver) {
				if (Reflect.has(target, prop)) {
					return Reflect.get(target, prop, receiver);
				}
				return () => undefined;
			},
		}) as unknown as ExtensionAPI,
		commands,
		sentMessages,
		setModelCalls,
	};
}

describe("forge transitions from model output", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("passes the last implementer message to the reviewer and feeds reviewer findings back to the coder", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		await createIssue(cwd, {
			id: "tau-xyz",
			title: "Forge task",
			actor: "test",
			fields: { status: "open", issue_type: "task", description: "Fix the forge flow." },
		});

		const implementerModel: ModelRef = {
			provider: "anthropic",
			id: "claude-opus-4-5",
			name: "claude-opus-4-5",
		};
		const reviewerModel: ModelRef = {
			provider: "openai",
			id: "gpt-5",
			name: "gpt-5",
		};
		const modelRegistry = {
			getAll: () => [implementerModel, reviewerModel],
		} as unknown as ModelRegistry;

		const context = makeContext(cwd, implementerModel, modelRegistry);
		let newSessionCount = 0;
		context.newSession = async () => {
			newSessionCount += 1;
			if (newSessionCount === 2) {
				const state = loadState(cwd, "tau-xyz");
				if (state) {
					state.status = "paused";
					saveState(cwd, state);
				}
			}
			return { cancelled: false };
		};

		const reviewJson = JSON.stringify({
			findings: [
				{
					title: "Tighten auth validation",
					body: "The new auth path still accepts malformed tokens.",
					confidence_score: 0.96,
					priority: 1,
					code_location: {
						absolute_file_path: "/tmp/auth.ts",
						line_range: { start: 10, end: 12 },
					},
				},
			],
			overall_correctness: "patch is incorrect",
			overall_explanation: "A blocking auth issue remains.",
			overall_confidence_score: 0.94,
		});

		const stub = makePiStub(context, [
			"Implemented the requested auth changes and added tests.",
			reviewJson,
		]);
		initForge(stub.pi);

		const forgeCommand = stub.commands.get("forge");
		expect(forgeCommand).toBeDefined();

		await forgeCommand?.handler("set tau-xyz openai/gpt-5", context);
		await forgeCommand?.handler("start tau-xyz", context);

		expect(stub.sentMessages).toHaveLength(2);
		expect(stub.sentMessages[1]).toContain("Implemented the requested auth changes and added tests.");
		expect(stub.sentMessages[1]).toContain("Return ONLY a JSON object");
		expect(stub.setModelCalls).toEqual([
			modelId(reviewerModel),
			modelId(implementerModel),
		]);
		expect(newSessionCount).toBe(2);

		const state = loadState(cwd, "tau-xyz") as ForgeState | undefined;
		expect(state?.phase).toBe("implementing");
		expect(state?.cycle).toBe(2);
		expect(state?.lastImplementerMessage).toBe("Implemented the requested auth changes and added tests.");
		expect(state?.lastReview?.findings).toHaveLength(1);
		expect(state?.lastReview?.findings[0]?.title).toBe("Tighten auth validation");
	});

	it("completes the forge when the reviewer returns no findings", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		await createIssue(cwd, {
			id: "tau-done",
			title: "Forge complete task",
			actor: "test",
			fields: { status: "open", issue_type: "task", description: "Ship the final patch." },
		});

		const implementerModel: ModelRef = {
			provider: "anthropic",
			id: "claude-opus-4-5",
			name: "claude-opus-4-5",
		};
		const reviewerModel: ModelRef = {
			provider: "openai",
			id: "gpt-5",
			name: "gpt-5",
		};
		const modelRegistry = {
			getAll: () => [implementerModel, reviewerModel],
		} as unknown as ModelRegistry;

		const context = makeContext(cwd, implementerModel, modelRegistry);
		let newSessionCount = 0;
		context.newSession = async () => {
			newSessionCount += 1;
			return { cancelled: false };
		};

		const stub = makePiStub(context, [
			"Finished the requested patch and tests.",
			JSON.stringify({
				findings: [],
				overall_correctness: "patch is correct",
				overall_explanation: "No blocking issues remain.",
				overall_confidence_score: 0.91,
			}),
		]);
		initForge(stub.pi);

		const forgeCommand = stub.commands.get("forge");
		expect(forgeCommand).toBeDefined();

		await forgeCommand?.handler("set tau-done openai/gpt-5", context);
		await forgeCommand?.handler("start tau-done", context);

		const state = loadState(cwd, "tau-done") as ForgeState | undefined;
		expect(state?.status).toBe("completed");
		expect(state?.completedAt).toBeDefined();
		expect(newSessionCount).toBe(1);
		expect(stub.setModelCalls).toEqual([
			modelId(reviewerModel),
			modelId(implementerModel),
		]);
	});
});
