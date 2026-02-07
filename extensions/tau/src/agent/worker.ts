import {
	createAgentSession,
	type AgentSession,
	SessionManager,
	SettingsManager,
	AuthStorage,
	ModelRegistry,
	DefaultResourceLoader,
	type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import type { Model, Api, ThinkingLevel, Message } from "@mariozechner/pi-ai";
import { stream, streamSimple } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { Effect, SubscriptionRef, Stream } from "effect";
import { type Status } from "./status.js";
import type { AgentId, AgentDefinition } from "./types.js";
import { type Agent, AgentError } from "./services.js";
import { computeClampedWorkerSandboxConfig } from "./sandbox-policy.js";
import type { SandboxConfig } from "../sandbox/config.js";
import {
	TAU_PERSISTED_STATE_TYPE,
	loadPersistedState,
} from "../shared/state.js";
import { withWorkerSandboxOverride } from "./worker-sandbox.js";
import { setWorkerApprovalBroker } from "./approval-broker.js";

import type { ApprovalBroker } from "./approval-broker.js";
import { createWorkerAgentTool } from "./runtime.js";

function truncateStr(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max - 3) + "...";
}

// Extract human-readable args for tool display
function formatToolArgs(toolName: string, args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;

	switch (toolName) {
		case "bash":
			return typeof a["command"] === "string" ? a["command"] : "";
		case "read":
			return typeof a["path"] === "string" ? a["path"] : "";
		case "write":
			return typeof a["path"] === "string" ? `${a["path"]} (create)` : "";
		case "edit":
			return typeof a["path"] === "string" ? `${a["path"]} (edit)` : "";
		default:
			// For unknown tools, try to find a meaningful field
			if (typeof a["path"] === "string") return a["path"];
			if (typeof a["command"] === "string") return a["command"];
			if (typeof a["query"] === "string") return a["query"];
			return "";
	}
}

const WORKER_DELEGATION_PROMPT = `## Worker Agent Instructions

You are a worker agent spawned by an orchestrator. Follow these rules:

1. **Execute only what was requested** - Focus on the specific task in your instructions.
2. **Use beads for context** - If given a task ID, run \`bd show <id>\` to get full context.
3. **Report discoveries, don't fix unrelated issues** - If you discover bugs or issues outside your task scope:
   - Create a beads task: \`bd create "Description" --type task\`
   - Do NOT attempt to fix them
   - Continue with your assigned work
4. **Add notes for the orchestrator** - Use \`bd update <id> --note "..."\` to communicate findings.
5. **Parallel work** - Other agents may work on the codebase simultaneously. If you notice changes you didn't make, ignore them and continue with your assigned task.
6. **Git is BLOCKED** - You cannot run git commands. The orchestrator handles all git operations. Attempting git commands will fail.
7. **Only your final message is returned** - Make it a clear summary of what was done.
`;

function toolOnlyStreamFn(
	model: Model<Api>,
	context: Message[],
	options?: Record<string, unknown>,
) {
	// Build options without undefined values (exactOptionalPropertyTypes compliance)
	const base: Record<string, unknown> = {
		maxTokens: (options?.["maxTokens"] as number | undefined) || Math.min(model.maxTokens, 32000),
	};
	if (options?.["temperature"] !== undefined) base["temperature"] = options["temperature"];
	if (options?.["signal"] !== undefined) base["signal"] = options["signal"];
	if (options?.["apiKey"] !== undefined) base["apiKey"] = options["apiKey"];
	if (options?.["sessionId"] !== undefined) base["sessionId"] = options["sessionId"];

	const api = model.api as string;
	const ctx = { messages: context };

	switch (api) {
		case "anthropic-messages":
			return stream(model as Model<"anthropic-messages">, ctx, { ...base, thinkingEnabled: false, toolChoice: "any" });
		case "openai-completions":
			return stream(model as Model<"openai-completions">, ctx, { ...base, toolChoice: "required" });
		case "google-generative-ai":
		case "google-vertex":
		case "google-gemini-cli":
			return stream(model as Model<"google-generative-ai">, ctx, { ...base, toolChoice: "any", thinking: { enabled: false } });
		case "bedrock-converse-stream":
		case "amazon-bedrock":
			return stream(model as Model<"bedrock-converse-stream">, ctx, { ...base, toolChoice: "any" });
		default:
			return streamSimple(model, { messages: context }, options);
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

export function buildWorkerAppendPrompts(options: {
	definition: AgentDefinition;
	resultSchema?: unknown;
}): string[] {
	const prompts: string[] = [];

	// Always add the worker delegation prompt
	prompts.push(WORKER_DELEGATION_PROMPT);

	// Add agent-specific system prompt if present
	if (options.definition.systemPrompt) {
		prompts.push(options.definition.systemPrompt);
	}

	// Append structured output instructions if schema provided
	if (options.resultSchema) {
		prompts.push(`## Structured Output\n- You must call submit_result exactly once with JSON matching the provided schema.\n- Do not respond with free text.\n- Stop immediately after calling submit_result.\n\nSchema:\n\n\`\`\`json\n${JSON.stringify(options.resultSchema, null, 2)}\n\`\`\``);
	}

	return prompts;
}

import type { ToolRecord } from "./status.js";

export class AgentWorker implements Agent {
	private structuredOutput?: unknown;
	private turns = 0;
	private toolCalls = 0;
	private workedMs = 0;
	private turnStartTime: number | undefined = undefined;
	private tools: ToolRecord[] = [];
	private pendingTools: Map<string, ToolRecord> = new Map();

	constructor(
		readonly id: AgentId,
		readonly type: string,
		readonly depth: number,
		private session: AgentSession,
		private statusRef: SubscriptionRef.SubscriptionRef<Status>,
	) {}

	static make(opts: {
		definition: AgentDefinition;
		depth: number;
		cwd: string;
		parentSessionId: string;
		parentSandboxConfig: Required<SandboxConfig>;
		parentModel: Model<Api> | undefined;
		approvalBroker: ApprovalBroker | undefined;
		resultSchema?: unknown;
	}) {
		return Effect.gen(function* () {
			const authStorage = new AuthStorage();
			const modelRegistry = new ModelRegistry(authStorage);

			const appendPrompts = buildWorkerAppendPrompts({
				definition: opts.definition,
				resultSchema: opts.resultSchema,
			});

			const statusRef = yield* SubscriptionRef.make<Status>({ state: "pending" });

			// Use explicit definition model, or inherit from parent
			const definitionModel = opts.definition.model;
			const resolvedModel = (definitionModel && definitionModel !== "inherit")
				? resolveModelPattern(definitionModel, modelRegistry.getAll())
				: opts.parentModel;

			let agent: AgentWorker;

			// Create mutable context for agent tool - parentSessionId will be updated after session creation
			const agentContext = {
				parentSessionId: opts.parentSessionId, // Placeholder, updated below
				parentModel: opts.parentModel,
				cwd: opts.cwd,
				approvalBroker: opts.approvalBroker,
			};

			// Create agent tool for nested spawning (uses agentContext by reference)
			const agentTool = createWorkerAgentTool(agentContext);

			// Build custom tools array
			const customTools: ToolDefinition[] = [agentTool as ToolDefinition];

			// Add submit_result tool if structured output is requested
			if (opts.resultSchema) {
				customTools.push({
					name: "submit_result",
					label: "submit_result",
					description: "Submit structured result for the task",
					parameters: Type.Unsafe(opts.resultSchema as object),
					async execute(_toolCallId: string, params: unknown, signal: AbortSignal | undefined, _onUpdate, _ctx) {
						if (signal?.aborted) throw new Error("Aborted");
						agent.structuredOutput = params;
						agent.session.abort().catch(() => undefined);
						return {
							content: [{ type: "text" as const, text: "Result received." }],
							details: { ok: true },
						};
					},
				} as ToolDefinition);
			}

			const settingsManager = SettingsManager.inMemory();

			// Create resource loader that injects worker-specific prompts
			// This also loads AGENTS.md and skills from pi's discovery
			const resourceLoader = new DefaultResourceLoader({
				cwd: opts.cwd,
				settingsManager,
				appendSystemPromptOverride: (base) => [...base, ...appendPrompts],
			});
			yield* Effect.promise(() => resourceLoader.reload());

			const sessionOpts = {
				cwd: opts.cwd,
				authStorage,
				modelRegistry,
				sessionManager: SessionManager.inMemory(opts.cwd),
				settingsManager,
				resourceLoader,
				customTools,
				...(resolvedModel ? { model: resolvedModel } : {}),
			};
			const { session } = yield* Effect.promise(() => createAgentSession(sessionOpts));

			// Update context with actual session ID so nested spawns use this worker's ID
			agentContext.parentSessionId = session.sessionId;

			const sandboxConfig = computeClampedWorkerSandboxConfig(
				opts.definition.sandbox
					? { parent: opts.parentSandboxConfig, requested: opts.definition.sandbox }
					: { parent: opts.parentSandboxConfig },
			);

			// Re-snapshot: update the worker's tau sandbox override and approval broker
			{
				const persisted = loadPersistedState({
					sessionManager: session.sessionManager,
				});
				const next = withWorkerSandboxOverride(persisted, sandboxConfig);
				session.sessionManager.appendCustomEntry(TAU_PERSISTED_STATE_TYPE, next);
				setWorkerApprovalBroker(session.sessionId, opts.approvalBroker);
			}

			// Apply thinking level from definition (if not "inherit")
			const thinkingLevel = opts.definition.thinking;
			if (thinkingLevel && thinkingLevel !== "inherit") {
				session.setThinkingLevel(thinkingLevel as ThinkingLevel);
			}

			if (opts.resultSchema) {
				session.agent.streamFn = toolOnlyStreamFn as unknown as typeof session.agent.streamFn;
			}

			agent = new AgentWorker(
				session.sessionId as AgentId,
				opts.definition.name,
				opts.depth,
				session,
				statusRef,
			);

			// Subscribe to session events to update status with progress
			session.subscribe((event) => {
				if (event.type === "turn_start") {
					agent.turns++;
					agent.turnStartTime = Date.now();
					Effect.runFork(SubscriptionRef.set(statusRef, { 
						state: "running",
						turns: agent.turns,
						toolCalls: agent.toolCalls,
						workedMs: agent.workedMs,
						tools: agent.tools,
					}));
				} else if (event.type === "turn_end") {
					if (agent.turnStartTime !== undefined) {
						agent.workedMs += Date.now() - agent.turnStartTime;
						agent.turnStartTime = undefined;
					}
					Effect.runFork(SubscriptionRef.set(statusRef, { 
						state: "running",
						turns: agent.turns,
						toolCalls: agent.toolCalls,
						workedMs: agent.workedMs,
						tools: agent.tools,
					}));
				} else if (event.type === "tool_execution_start") {
					agent.toolCalls++;
					const argsPreview = truncateStr(formatToolArgs(event.toolName, event.args), 100);
					agent.pendingTools.set(event.toolCallId, { 
						name: event.toolName, 
						args: argsPreview,
					});
					Effect.runFork(SubscriptionRef.set(statusRef, { 
						state: "running",
						turns: agent.turns,
						toolCalls: agent.toolCalls,
						workedMs: agent.workedMs,
						tools: agent.tools,
					}));
				} else if (event.type === "tool_execution_end") {
					const pending = agent.pendingTools.get(event.toolCallId);
					if (pending) {
						agent.pendingTools.delete(event.toolCallId);
						const resultPreview = truncateStr(
							typeof event.result === "string" ? event.result : JSON.stringify(event.result), 
							100
						);
						agent.tools.push({
							...pending,
							result: resultPreview,
							isError: event.isError,
						});
					}
					Effect.runFork(SubscriptionRef.set(statusRef, { 
						state: "running",
						turns: agent.turns,
						toolCalls: agent.toolCalls,
						workedMs: agent.workedMs,
						tools: agent.tools,
					}));
				} else if (event.type === "agent_end") {
					// Finalize any in-progress turn
					if (agent.turnStartTime !== undefined) {
						agent.workedMs += Date.now() - agent.turnStartTime;
						agent.turnStartTime = undefined;
					}
					
					const lastMsg = event.messages[event.messages.length - 1];

					// Check if the last assistant message ended with an error
					// (HTTP 500, rate limit exhausted, overloaded, etc.)
					const assistantMsg = lastMsg?.role === "assistant" ? lastMsg as {
						role: "assistant";
						content: Array<{ type: string; text?: string }>;
						stopReason?: string;
						errorMessage?: string;
					} : undefined;

					if (assistantMsg?.stopReason === "error") {
						const reason = assistantMsg.errorMessage
							|| assistantMsg.content
								.filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof p.text === "string")
								.map((p) => p.text)
								.join("\n")
							|| "Agent ended with error (no details provided)";

						Effect.runFork(
							SubscriptionRef.set(statusRef, {
								state: "failed",
								reason,
								turns: agent.turns,
								toolCalls: agent.toolCalls,
								workedMs: agent.workedMs,
								tools: agent.tools,
							}),
						);
					} else if (assistantMsg?.stopReason === "aborted" && agent.structuredOutput === undefined) {
						// Aborted without producing structured output or text
						const textContent = assistantMsg.content
							.filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof p.text === "string")
							.map((p) => p.text)
							.join("\n");

						if (!textContent) {
							Effect.runFork(
								SubscriptionRef.set(statusRef, {
									state: "failed",
									reason: "Agent was aborted before producing a response",
									turns: agent.turns,
									toolCalls: agent.toolCalls,
									workedMs: agent.workedMs,
									tools: agent.tools,
								}),
							);
						} else {
							Effect.runFork(
								SubscriptionRef.set(statusRef, {
									state: "completed",
									message: textContent,
									structured_output: agent.structuredOutput,
									turns: agent.turns,
									toolCalls: agent.toolCalls,
									workedMs: agent.workedMs,
									tools: agent.tools,
								}),
							);
						}
					} else {
						const message =
							assistantMsg
								? assistantMsg.content
										.filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof p.text === "string")
										.map((p) => p.text)
										.join("\n")
								: undefined;

						Effect.runFork(
							SubscriptionRef.set(statusRef, {
								state: "completed",
								message,
								structured_output: agent.structuredOutput,
								turns: agent.turns,
								toolCalls: agent.toolCalls,
								workedMs: agent.workedMs,
								tools: agent.tools,
							}),
						);
					}
				}
			});

			return agent;
		});
	}

	prompt(message: string): Effect.Effect<string, AgentError> {
		return Effect.gen(this, function* () {
			const submissionId = `sub-${crypto.randomUUID()}`;

			// Transition to "running" immediately so callers see progress
			// (session events will continue updating from here)
			yield* SubscriptionRef.set(this.statusRef, {
				state: "running",
				turns: this.turns,
				toolCalls: this.toolCalls,
				workedMs: this.workedMs,
				tools: this.tools,
			});

			Effect.runFork(
				Effect.tryPromise({
					try: () => this.session.prompt(message, { source: "extension" }),
					catch: (err) => err,
				}).pipe(
					Effect.catchAll((err: unknown) => {
						const reason = err instanceof Error ? err.message : String(err);
						return SubscriptionRef.set(this.statusRef, {
							state: "failed",
							reason,
							turns: this.turns,
							toolCalls: this.toolCalls,
							workedMs: this.workedMs,
							tools: this.tools,
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
