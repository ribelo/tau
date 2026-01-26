import {
	createAgentSession,
	type AgentSession,
	SessionManager,
	SettingsManager,
	discoverAuthStorage,
	discoverModels,
} from "@mariozechner/pi-coding-agent";
import type { Model, Api, ThinkingLevel, Message } from "@mariozechner/pi-ai";
import { stream, streamSimple } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { Effect, SubscriptionRef, Stream } from "effect";
import { type Status, isFinal } from "./status.js";
import type { AgentId, ResolvedPolicy } from "./types.js";
import { type Agent, AgentError } from "./services.js";
import { computeClampedWorkerSandboxConfig } from "./sandbox-policy.js";
import type { SandboxConfig } from "../sandbox/config.js";
import type { LoadedSkill } from "./skills.js";
import {
	TAU_PERSISTED_STATE_TYPE,
	loadPersistedState,
} from "../shared/state.js";
import { withWorkerSandboxOverride } from "./worker-sandbox.js";
import { setWorkerApprovalBroker } from "./approval-broker.js";
import type { ApprovalBroker } from "./approval-broker.js";

const TOOL_CHOICE_APIS = new Set([
	"anthropic-messages",
	"openai-completions",
	"google-generative-ai",
	"google-vertex",
	"google-gemini-cli",
	"bedrock-converse-stream",
	"amazon-bedrock",
]);

function toolOnlyStreamFn(
	model: Model<Api>,
	context: Message[],
	options?: any,
) {
	const base = {
		temperature: options?.temperature,
		maxTokens: options?.maxTokens || Math.min(model.maxTokens, 32000),
		signal: options?.signal,
		apiKey: options?.apiKey,
		sessionId: options?.sessionId,
	};

	switch (model.api) {
		case "anthropic-messages":
			return stream(model as Model<"anthropic-messages">, (context as any).messages || context, {
				...base,
				thinkingEnabled: false,
				toolChoice: "any",
			});
		case "openai-completions":
			return stream(model as Model<"openai-completions">, (context as any).messages || context, {
				...base,
				toolChoice: "required",
			});
		case "google-generative-ai":
		case "google-vertex":
		case "google-gemini-cli":
			return stream(model as any, (context as any).messages || context, {
				...base,
				toolChoice: "any",
				thinking: { enabled: false },
			});
		case "bedrock-converse-stream":
		case "amazon-bedrock":
			return stream(model as any, (context as any).messages || context, { ...base, toolChoice: "any" });
		default:
			return streamSimple(model, context, options);
	}
}

function resolveModelPattern(
	pattern: string,
	models: Model<Api>[],
): Model<Api> | undefined {
	const trimmed = pattern.trim();
	if (!trimmed) return undefined;

	const slashIndex = trimmed.indexOf("/");
	if (slashIndex !== -1) {
		const provider = trimmed.slice(0, slashIndex).toLowerCase();
		const modelId = trimmed.slice(slashIndex + 1).toLowerCase();
		const match = models.find(
			(m) =>
				m.provider.toLowerCase() === provider &&
				m.id.toLowerCase() === modelId,
		);
		if (match) return match;
	}

	const exact = models.find((m) => m.id.toLowerCase() === trimmed.toLowerCase());
	if (exact) return exact;

	const partial = models.find(
		(m) =>
			m.id.toLowerCase().includes(trimmed.toLowerCase()) ||
			m.name?.toLowerCase().includes(trimmed.toLowerCase()),
	);
	return partial;
}

export function buildWorkerSystemPrompt(options: {
	parentSessionId: string;
	skills: LoadedSkill[];
}): string {
	const lines: string[] = [];
	lines.push("# Task Execution Context");
	lines.push(
		`You are executing a delegated task from parent session: ${options.parentSessionId}`,
	);
	lines.push("");
	lines.push("## Guidelines");
	lines.push("- Focus on the requested task");
	lines.push("- Use available tools as needed");
	lines.push("- If specific output format required, follow it exactly");
	lines.push("- Otherwise, summarize what you did and why");

	if (options.skills.length > 0) {
		lines.push("");
		lines.push("---");
		for (const s of options.skills) {
			lines.push(`<skill name="${s.name}" path="${s.path}">`);
			lines.push(s.contents.trim());
			lines.push("</skill>");
			lines.push("");
		}
	}

	return lines.join("\n").trim() + "\n";
}

export class AgentWorker implements Agent {
	private structuredOutput?: unknown;

	constructor(
		readonly id: AgentId,
		readonly type: string,
		readonly depth: number,
		private session: AgentSession,
		private statusRef: SubscriptionRef.SubscriptionRef<Status>,
	) {}

	static make(opts: {
		type: string;
		depth: number;
		policy: ResolvedPolicy;
		cwd: string;
		parentSessionId: string;
		parentSandboxConfig: Required<SandboxConfig>;
		approvalBroker?: ApprovalBroker;
		skills: LoadedSkill[];
		resultSchema?: any;
	}) {
		return Effect.gen(function* () {
			const authStorage = discoverAuthStorage();
			const modelRegistry = discoverModels(authStorage);

			const systemPromptBase = buildWorkerSystemPrompt({
				parentSessionId: opts.parentSessionId,
				skills: opts.skills,
			});

			const systemPrompt = opts.resultSchema
				? `${systemPromptBase}\n\n## Structured Output\n- You must call submit_result exactly once with JSON matching the provided schema.\n- Do not respond with free text.\n- Stop immediately after calling submit_result.\n\nSchema:\n\n\`\`\`json\n${JSON.stringify(opts.resultSchema, null, 2)}\n\`\`\`\n`
				: systemPromptBase;

			const statusRef = yield* SubscriptionRef.make<Status>({ state: "pending" });

			const resolvedModel = opts.policy.model
				? resolveModelPattern(opts.policy.model, modelRegistry.getAll())
				: undefined;

			let agent: AgentWorker;

			const customTools = opts.resultSchema
				? [
						{
							name: "submit_result",
							label: "submit_result",
							description: "Submit structured result for the task",
							parameters: Type.Unsafe(opts.resultSchema),
							async execute(
								_toolCallId: string,
								params: any,
								_onUpdate: any,
								_ctx: any,
								signal?: AbortSignal,
							) {
								if (signal?.aborted) throw new Error("Aborted");
								agent.structuredOutput = params;
								agent.session.abort().catch(() => undefined);
								return {
									content: [{ type: "text", text: "Result received." }],
									details: { ok: true },
								};
							},
						},
					]
				: undefined;

			const { session } = yield* Effect.promise(() =>
				createAgentSession({
					cwd: opts.cwd,
					authStorage,
					modelRegistry,
					sessionManager: SessionManager.inMemory(opts.cwd),
					settingsManager: SettingsManager.inMemory(),
					systemPrompt: (defaultPrompt) => `${defaultPrompt}\n\n${systemPrompt}`,
					skills: [],
					customTools: customTools as any,
					model: resolvedModel,
				}),
			);

			const sandboxConfig = computeClampedWorkerSandboxConfig({
				parent: opts.parentSandboxConfig,
				requested: opts.policy.sandbox,
			});

			// Re-snapshot: update the worker's tau sandbox override and approval broker
			{
				const persisted = loadPersistedState({
					sessionManager: session.sessionManager,
				});
				const next = withWorkerSandboxOverride(persisted, sandboxConfig);
				session.sessionManager.appendCustomEntry(TAU_PERSISTED_STATE_TYPE, next);
				setWorkerApprovalBroker(session.sessionId, opts.approvalBroker);
			}

			if (opts.policy.thinking) {
				session.setThinkingLevel(opts.policy.thinking as ThinkingLevel);
			}

			if (opts.resultSchema) {
				session.agent.streamFn = toolOnlyStreamFn as any;
			}

			agent = new AgentWorker(
				session.sessionId as AgentId,
				opts.type,
				opts.depth,
				session,
				statusRef,
			);

			// Subscribe to session events to update status
			session.subscribe((event) => {
				if (event.type === "message_start") {
					Effect.runFork(SubscriptionRef.set(statusRef, { state: "running" }));
				} else if (event.type === "agent_end") {
					const lastMsg = event.messages[event.messages.length - 1];
					const message =
						lastMsg?.role === "assistant"
							? lastMsg.content
									.filter((p: any) => p.type === "text")
									.map((p: any) => p.text)
									.join("\n")
							: undefined;

					Effect.runFork(
						SubscriptionRef.set(statusRef, {
							state: "completed",
							message,
							structured_output: agent.structuredOutput,
						}),
					);
				}
			});

			return agent;
		});
	}

	prompt(message: string): Effect.Effect<string, AgentError> {
		return Effect.gen(this, function* () {
			// For now, we'll just return a dummy or use session ID as base for submission
			const submissionId = `sub-${crypto.randomUUID()}`;

			Effect.runFork(
				Effect.promise(() =>
					this.session.prompt(message, { source: "extension" }),
				).pipe(
					Effect.catchAll((err) => {
						// Log error but don't fail the prompt return as it's fire-and-forget-ish
						return SubscriptionRef.set(this.statusRef, {
							state: "failed",
							reason: err instanceof Error ? err.message : String(err),
						});
					}),
				),
			);

			return submissionId;
		});
	}

	interrupt(): Effect.Effect<void> {
		return Effect.promise(() => this.session.abort());
	}

	shutdown(): Effect.Effect<void> {
		return Effect.gen(this, function* () {
			yield* Effect.promise(() => this.session.abort());
			yield* SubscriptionRef.set(this.statusRef, { state: "shutdown" });
		});
	}

	get status(): Effect.Effect<Status> {
		return SubscriptionRef.get(this.statusRef);
	}

	subscribeStatus(): Stream.Stream<Status> {
		return this.statusRef.changes;
	}
}
