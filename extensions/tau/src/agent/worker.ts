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
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Model, Api, ThinkingLevel, Context, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { stream, streamSimple } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { Effect, SubscriptionRef, Stream } from "effect";
import { nanoid } from "nanoid";
import { type Status } from "./status.js";
import type { AgentId, AgentDefinition, ModelSpec } from "./types.js";
import { type Agent, AgentError } from "./services.js";
import { computeClampedWorkerSandboxConfig } from "./sandbox-policy.js";
import type { ResolvedSandboxConfig } from "../sandbox/config.js";
import { TAU_PERSISTED_STATE_TYPE, loadPersistedState } from "../shared/state.js";
import { withWorkerSandboxOverride } from "./worker-sandbox.js";
import { setWorkerApprovalBroker } from "./approval-broker.js";
import { createApplyPatchToolDefinition } from "../sandbox/apply-patch.js";
import { createBacklogToolDefinition } from "../backlog/tool.js";
import { createExaToolDefinitions } from "../exa/index.js";
import { createMemoryToolDefinition } from "../memory/index.js";
import { createThreadToolDefinitions } from "../thread/index.js";
import { isRecord } from "../shared/json.js";

import type { ApprovalBroker } from "./approval-broker.js";
import { createWorkerAgentTool, type RunAgentControlPromise } from "./runtime.js";
import { applyAgentToolAllowlist } from "./tool-allowlist.js";
import { buildToolDescription } from "./tool.js";
import { isAgentDisabledForCwd } from "../agents-menu/index.js";

const MAX_SUBMIT_RESULT_RETRIES = 3;

type AssistantTextPart = { type: string; text?: string };

type AssistantLikeMessage = {
	role: "assistant";
	content?: ReadonlyArray<AssistantTextPart>;
	stopReason?: string;
	errorMessage?: string;
};

function truncateStr(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max - 3) + "...";
}

function getAssistantText(message: AssistantLikeMessage | undefined): string {
	if (!message) {
		return "";
	}

	return (
		message.content
			?.filter(
				(part): part is { type: "text"; text: string } =>
					part.type === "text" && typeof part.text === "string",
			)
			.map((part) => part.text)
			.join("\n") ?? ""
	);
}

function getAssistantFailureReason(
	message: AssistantLikeMessage | undefined,
	fallback: string,
): string {
	const text = getAssistantText(message);
	return message?.errorMessage || text || fallback;
}

function getLastAssistantMessage(messages: readonly unknown[]): AssistantLikeMessage | undefined {
	const last = messages[messages.length - 1];
	if (!last || typeof last !== "object") {
		return undefined;
	}

	const candidate = last as Partial<AssistantLikeMessage> & { role?: unknown };
	return candidate.role === "assistant"
		? (candidate as AssistantLikeMessage)
		: undefined;
}

function waitForSessionSettlement(
	session: AgentSession,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	return new Promise((resolve) => {
		let pendingFailureTimer: ReturnType<typeof setTimeout> | undefined = undefined;

		const clearPendingFailureTimer = (): void => {
			if (pendingFailureTimer !== undefined) {
				clearTimeout(pendingFailureTimer);
				pendingFailureTimer = undefined;
			}
		};

		const finish = (result: { ok: true } | { ok: false; reason: string }): void => {
			clearPendingFailureTimer();
			unsubscribe();
			resolve(result);
		};

		const settleFromCurrentState = (): void => {
			if (session.isStreaming || session.isCompacting) {
				return;
			}

			const assistant = getLastAssistantMessage(session.messages);
			if (assistant?.stopReason === "error") {
				clearPendingFailureTimer();
				pendingFailureTimer = setTimeout(() => {
					pendingFailureTimer = undefined;
					finish({
						ok: false,
						reason: getAssistantFailureReason(assistant, "Agent ended with error"),
					});
				}, 0);
				return;
			}

			finish({ ok: true });
		};

		const unsubscribe = session.subscribe((event) => {
			if (event.type === "auto_compaction_start") {
				clearPendingFailureTimer();
				return;
			}

			if (event.type === "auto_compaction_end") {
				clearPendingFailureTimer();
				if (event.errorMessage) {
					finish({ ok: false, reason: event.errorMessage });
					return;
				}
				if (!event.willRetry) {
					setTimeout(settleFromCurrentState, 0);
				}
				return;
			}

			if (event.type === "agent_end") {
				const assistant = getLastAssistantMessage(event.messages);
				if (assistant?.stopReason === "error") {
					clearPendingFailureTimer();
					pendingFailureTimer = setTimeout(() => {
						pendingFailureTimer = undefined;
						finish({
							ok: false,
							reason: getAssistantFailureReason(assistant, "Agent ended with error"),
						});
					}, 0);
					return;
				}

				finish({ ok: true });
			}
		});

		settleFromCurrentState();
	});
}

// Extract human-readable args for tool display
function formatToolArgs(toolName: string, args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;

	switch (toolName) {
		case "bash":
			return typeof a["command"] === "string" ? a["command"] : "";
		case "backlog":
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

export const WORKER_DELEGATION_PROMPT = `## Worker Agent Instructions

You are a worker agent spawned by an orchestrator. Follow these rules:

1. **Execute only what was requested** - Focus on the specific task in your instructions.
2. **Read spec from backlog** - If given a task ID, run \`backlog show <id>\` for context.
3. **Orchestrator owns git** - Do not commit, rebase, push, or change git state.
4. **Orchestrator owns review** - Do not spawn review agents.
5. **Orchestrator owns backlog state** - Do not create, close, or update backlog tasks unless explicitly asked. Only read with \`backlog show\` by default.
6. **Stay on task** - If you discover unrelated bugs, report them in your final message. Do not fix them and do not create follow-up backlog items unless explicitly asked. The orchestrator handles follow-up.
7. **Other agents may work simultaneously** - Ignore changes you didn't make.
8. **Only your final message is returned** - Make it a clear summary.
`;

function mergePayloadOverrides(
	payload: unknown,
	overrides: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
	const base = isRecord(payload) ? payload : {};
	return {
		...base,
		...overrides,
	};
}

function wrapPayloadOverrides(
	existing: SimpleStreamOptions["onPayload"] | undefined,
	overrides: Readonly<Record<string, unknown>>,
): NonNullable<SimpleStreamOptions["onPayload"]> {
	return async (payload, currentModel) => {
		const nextPayload = existing
			? await existing(payload, currentModel)
			: undefined;
		return mergePayloadOverrides(nextPayload === undefined ? payload : nextPayload, overrides);
	};
}

function buildToolOnlyOptions(
	model: Model<Api>,
	options: SimpleStreamOptions | undefined,
	providerOverrides: Readonly<Record<string, unknown>>,
	payloadOverrides?: Readonly<Record<string, unknown>>,
	omitKeys: ReadonlyArray<keyof SimpleStreamOptions> = [],
): Record<string, unknown> {
	const next: Record<string, unknown> = {
		...options,
		...providerOverrides,
		maxTokens: options?.maxTokens ?? Math.min(model.maxTokens, 32000),
	};

	for (const key of omitKeys) {
		delete next[key];
	}

	if (payloadOverrides !== undefined) {
		next["onPayload"] = wrapPayloadOverrides(options?.onPayload, payloadOverrides);
	}

	return next;
}

export const toolOnlyStreamFn: StreamFn = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => {
	const api = model.api as string;

	switch (api) {
		case "anthropic-messages":
			return stream(model as Model<"anthropic-messages">, context, buildToolOnlyOptions(model, options, {
				thinkingEnabled: false,
				toolChoice: "any",
			}));
		case "openai-completions":
			return stream(model as Model<"openai-completions">, context, buildToolOnlyOptions(model, options, {
				toolChoice: "required",
			}));
		case "google-generative-ai":
		case "google-vertex":
		case "google-gemini-cli":
			return stream(model as Model<"google-generative-ai">, context, buildToolOnlyOptions(model, options, {
				toolChoice: "any",
				thinking: { enabled: false },
			}));
		case "bedrock-converse-stream":
		case "amazon-bedrock":
			return stream(
				model as Model<"bedrock-converse-stream">,
				context,
				buildToolOnlyOptions(
					model,
					options,
					{
						toolChoice: "any",
					},
					undefined,
					["reasoning", "thinkingBudgets"],
				),
			);
		default:
			return streamSimple(
				model,
				context,
				buildToolOnlyOptions(
					model,
					options,
					api === "mistral-conversations"
						? { toolChoice: "required" }
						: {},
					api === "openai-responses" || api === "openai-codex-responses" || api === "azure-openai-responses"
						? { tool_choice: "required" }
						: undefined,
				) as SimpleStreamOptions,
			);
	}
};

export function createWorkerCustomTools(
	agentTool: ToolDefinition,
	runEffect: RunAgentControlPromise,
): ToolDefinition[] {
	return [
		agentTool,
		createApplyPatchToolDefinition() as unknown as ToolDefinition,
		createBacklogToolDefinition() as unknown as ToolDefinition,
		createMemoryToolDefinition(runEffect) as unknown as ToolDefinition,
		...createExaToolDefinitions().map((tool) => tool as unknown as ToolDefinition),
		...createThreadToolDefinitions().map((tool) => tool as unknown as ToolDefinition),
	];
}

export function resolveModelPattern(pattern: string, models: Model<Api>[]): Model<Api> | undefined {
	const trimmed = pattern.trim();
	if (!trimmed) return undefined;

	const slashIndex = trimmed.indexOf("/");
	if (slashIndex !== -1) {
		const providerInput = trimmed.slice(0, slashIndex).trim();
		const modelIdInput = trimmed.slice(slashIndex + 1).trim();
		if (!providerInput || !modelIdInput) return undefined;

		const provider = providerInput.toLowerCase();
		const modelId = modelIdInput.toLowerCase();
		const match = models.find(
			(m) => m.provider.toLowerCase() === provider && m.id.toLowerCase() === modelId,
		);
		if (match) return match;

		const providerTemplate = models.find((m) => m.provider.toLowerCase() === provider);
		if (providerTemplate) {
			return {
				...providerTemplate,
				id: modelIdInput,
				name: modelIdInput,
			};
		}

		return undefined;
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

function buildWorkerAppendPrompts(options: {
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
		prompts.push(
			`## Structured Output\n- You must call submit_result exactly once with JSON matching the provided schema.\n- Do not respond with free text.\n- Stop immediately after calling submit_result.\n\nSchema:\n\n\`\`\`json\n${JSON.stringify(options.resultSchema, null, 2)}\n\`\`\``,
		);
	}

	return prompts;
}

import type { ToolRecord } from "./status.js";

/** Model-independent session infrastructure prepared once in make(). */
interface SessionInfra {
	readonly authStorage: AuthStorage;
	readonly modelRegistry: ModelRegistry;
	readonly settingsManager: SettingsManager;
	readonly resourceLoader: DefaultResourceLoader;
	readonly customTools: ToolDefinition[];
	readonly sandboxConfig: ResolvedSandboxConfig;
	readonly appendPrompts: string[];
	readonly cwd: string;
	readonly approvalBroker: ApprovalBroker | undefined;
	readonly definition: AgentDefinition;
	readonly resultSchema: unknown | undefined;
}

export class AgentWorker implements Agent {
	private structuredOutput?: unknown;
	private submitResultRetries = 0;
	private turns = 0;
	private toolCalls = 0;
	private workedMs = 0;
	private terminalState: "completed" | "failed" | "shutdown" | undefined = undefined;
	private turnStartTime: number | undefined = undefined;
	private tools: ToolRecord[] = [];
	private pendingTools: Map<string, ToolRecord> = new Map();
	private sessionUnsubscribe: (() => void) | undefined = undefined;

	constructor(
		readonly id: AgentId,
		readonly type: string,
		readonly depth: number,
		private session: AgentSession,
		private readonly statusRef: SubscriptionRef.SubscriptionRef<Status>,
		private readonly infra: SessionInfra,
		private readonly models: readonly ModelSpec[],
		private readonly parentModel: Model<Api> | undefined,
		private readonly agentContext: {
			parentSessionId: string;
			parentAgentId?: AgentId | undefined;
			parentModel: Model<Api> | undefined;
			modelRegistry: ModelRegistry;
			cwd: string;
			approvalBroker: ApprovalBroker | undefined;
		},
	) {}

	get definition(): AgentDefinition {
		return this.infra.definition;
	}

	private currentRunningStatus(): Status {
		return {
			state: "running",
			turns: this.turns,
			toolCalls: this.toolCalls,
			workedMs: this.workedMs,
			...(this.turnStartTime !== undefined
				? { activeTurnStartedAtMs: this.turnStartTime }
				: {}),
			tools: this.tools,
		};
	}

	private publishStatus(status: Status): void {
		Effect.runSync(SubscriptionRef.set(this.statusRef, status));
	}

	private publishRunningStatus(): void {
		this.publishStatus(this.currentRunningStatus());
	}

	private publishRunningStatusIfNotFinal(): void {
		if (this.terminalState !== undefined) {
			return;
		}
		this.publishRunningStatus();
	}

	private publishFailed(reason: string): void {
		this.terminalState = "failed";
		this.publishStatus({
			state: "failed",
			reason,
			turns: this.turns,
			toolCalls: this.toolCalls,
			workedMs: this.workedMs,
			tools: this.tools,
		});
	}

	private publishCompleted(message: string | undefined): void {
		this.terminalState = "completed";
		this.publishStatus({
			state: "completed",
			message,
			structured_output: this.structuredOutput,
			turns: this.turns,
			toolCalls: this.toolCalls,
			workedMs: this.workedMs,
			tools: this.tools,
		});
	}

	private repromptForSubmitResult(retry: number): Effect.Effect<void> {
		const reminderMessage = `You MUST call the submit_result tool with JSON matching the provided schema. This is retry ${retry} of ${MAX_SUBMIT_RESULT_RETRIES}. Call submit_result now.`;
		return Effect.tryPromise({
			try: () =>
				this.session.prompt(reminderMessage, {
					source: "extension",
					streamingBehavior: "steer",
				}),
			catch: (error) =>
				new Error(
					error instanceof Error ? error.message : String(error),
				),
		}).pipe(
			Effect.catch((error) => {
				const reason =
					error instanceof Error ? error.message : String(error);
				return Effect.sync(() => {
					this.publishFailed(reason);
				});
			}),
		);
	}

	static make(opts: {
		definition: AgentDefinition;
		depth: number;
		cwd: string;
		parentSessionId: string;
		parentSandboxConfig: ResolvedSandboxConfig;
		parentModel: Model<Api> | undefined;
		approvalBroker: ApprovalBroker | undefined;
		modelRegistry?: ModelRegistry | undefined;
		resultSchema?: unknown;
		runPromise: RunAgentControlPromise;
		agentSummaries?: ReadonlyArray<{ readonly name: string; readonly description: string }>;
	}) {
		return Effect.gen(function* () {
			const modelRegistry = opts.modelRegistry
				? opts.modelRegistry
				: new ModelRegistry(AuthStorage.create());
			const authStorage = modelRegistry.authStorage;

			const appendPrompts = buildWorkerAppendPrompts({
				definition: opts.definition,
				resultSchema: opts.resultSchema,
			});

			const statusRef = yield* SubscriptionRef.make<Status>({ state: "pending" });

			const models = opts.definition.models;

			// Stable agent ID (survives session recreation on model fallback)
			const agentId: AgentId = nanoid(12);

			// Mutable context for nested agent tool
			const agentContext = {
				parentSessionId: opts.parentSessionId,
				parentAgentId: agentId,
				parentModel: opts.parentModel,
				modelRegistry,
				cwd: opts.cwd,
				approvalBroker: opts.approvalBroker,
			};

			const agentTool = createWorkerAgentTool(
				opts.runPromise,
				agentContext,
				opts.agentSummaries
					? buildToolDescription(
							{ list: () => opts.agentSummaries ?? [] },
							opts.definition.spawns,
							(name) => isAgentDisabledForCwd(opts.cwd, name),
						)
					: "Manage non-blocking agent tasks. Actions: spawn, send, wait, close, list.",
			);

			const customTools = createWorkerCustomTools(agentTool as ToolDefinition, opts.runPromise);

			// submit_result tool placeholder - needs agent reference, set after construction
			let agent: AgentWorker;

			if (opts.resultSchema) {
				customTools.push({
					name: "submit_result",
					label: "submit_result",
					description: "Submit structured result for the task",
					parameters: Type.Unsafe(opts.resultSchema as object),
					async execute(
						_toolCallId: string,
						params: unknown,
						signal: AbortSignal | undefined,
						_onUpdate,
						_ctx,
					) {
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

			const resourceLoader = new DefaultResourceLoader({
				cwd: opts.cwd,
				settingsManager,
				appendSystemPromptOverride: (base) => [...base, ...appendPrompts],
			});
			yield* Effect.promise(() => resourceLoader.reload());

			const sandboxConfig = computeClampedWorkerSandboxConfig(
				opts.definition.sandbox
					? { parent: opts.parentSandboxConfig, requested: opts.definition.sandbox }
					: { parent: opts.parentSandboxConfig },
			);

			const infra: SessionInfra = {
				authStorage,
				modelRegistry,
				settingsManager,
				resourceLoader,
				customTools,
				sandboxConfig,
				appendPrompts,
				cwd: opts.cwd,
				approvalBroker: opts.approvalBroker,
				definition: opts.definition,
				resultSchema: opts.resultSchema,
			};

			// Create initial session with first model
			const firstSpec = models[0];
			if (!firstSpec) {
				return yield* Effect.fail(
					new AgentError({ message: "Agent definition has no models" }),
				);
			}
			const session = yield* createSessionForModel(
				infra,
				firstSpec,
				opts.parentModel,
				modelRegistry,
			);

			agentContext.parentSessionId = session.sessionId;

			// Wire sandbox and approval broker for the session
			wireSession(session, sandboxConfig, opts.approvalBroker);

			if (opts.resultSchema) {
				session.agent.streamFn = toolOnlyStreamFn;
			}

			agent = new AgentWorker(
				agentId,
				opts.definition.name,
				opts.depth,
				session,
				statusRef,
				infra,
				models,
				opts.parentModel,
				agentContext,
			);

			agent.subscribeToSession(session);

			return agent;
		});
	}

	/** Subscribe to session events for status tracking. Replaces any previous subscription. */
	private subscribeToSession(session: AgentSession): void {
		if (this.sessionUnsubscribe) {
			this.sessionUnsubscribe();
		}
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const agent = this;

		this.sessionUnsubscribe = session.subscribe((event) => {
			if (event.type === "turn_start") {
				agent.terminalState = undefined;
				agent.turns++;
				agent.turnStartTime = Date.now();
				agent.publishRunningStatus();
			} else if (event.type === "turn_end") {
				if (agent.turnStartTime !== undefined) {
					agent.workedMs += Date.now() - agent.turnStartTime;
					agent.turnStartTime = undefined;
				}
				agent.publishRunningStatusIfNotFinal();
			} else if (event.type === "tool_execution_start") {
				agent.toolCalls++;
				const argsPreview = truncateStr(formatToolArgs(event.toolName, event.args), 100);
				agent.pendingTools.set(event.toolCallId, {
					name: event.toolName,
					args: argsPreview,
				});
				agent.publishRunningStatus();
			} else if (event.type === "tool_execution_end") {
				const pending = agent.pendingTools.get(event.toolCallId);
				if (pending) {
					agent.pendingTools.delete(event.toolCallId);
					const resultPreview = truncateStr(
						typeof event.result === "string"
							? event.result
							: JSON.stringify(event.result),
						100,
					);
					agent.tools.push({
						...pending,
						result: resultPreview,
						isError: event.isError,
					});
				}
				agent.publishRunningStatusIfNotFinal();
			} else if (event.type === "auto_compaction_start") {
				agent.publishRunningStatusIfNotFinal();
			} else if (event.type === "auto_compaction_end") {
				if (event.errorMessage) {
					agent.publishRunningStatusIfNotFinal();
					return;
				}
				agent.publishRunningStatusIfNotFinal();
			} else if (event.type === "agent_end") {
				if (agent.turnStartTime !== undefined) {
					agent.workedMs += Date.now() - agent.turnStartTime;
					agent.turnStartTime = undefined;
				}

				const assistantMsg = getLastAssistantMessage(event.messages);

				if (assistantMsg?.stopReason === "error") {
					agent.publishRunningStatusIfNotFinal();
					return;
				}

				if (assistantMsg?.stopReason === "aborted") {
					// submit_result aborts the session after capturing output —
					// if structuredOutput is set, that's a successful completion.
					if (agent.structuredOutput !== undefined) {
						agent.publishCompleted(undefined);
						return;
					}
					// Explicit interrupt/close — do NOT retry, honor the abort.
					const textContent = getAssistantText(assistantMsg);

					if (!textContent) {
						agent.publishFailed("Agent was aborted before producing a response");
					} else {
						agent.publishCompleted(textContent);
					}
					return;
				}

				// Retry when structured output was requested but agent didn't call submit_result.
				// Only applies to non-aborted endings (normal turn completion without tool call).
				if (
					agent.infra.resultSchema !== undefined &&
					agent.structuredOutput === undefined
				) {
					if (agent.submitResultRetries < MAX_SUBMIT_RESULT_RETRIES) {
						agent.submitResultRetries += 1;
						Effect.runFork(
							agent.repromptForSubmitResult(agent.submitResultRetries),
						);
					} else {
						agent.publishFailed(
							`Agent did not call submit_result after ${MAX_SUBMIT_RESULT_RETRIES} retries`,
						);
					}
					return;
				}

				const message = assistantMsg ? getAssistantText(assistantMsg) : undefined;

				agent.publishCompleted(message);
			}
		});
	}

	private switchToModel(
		spec: ModelSpec,
	): Effect.Effect<void, string> {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const worker = this;
		return Effect.gen(function* () {
			yield* Effect.promise(() => worker.session.abort()).pipe(Effect.ignore);
			if (worker.sessionUnsubscribe) {
				worker.sessionUnsubscribe();
				worker.sessionUnsubscribe = undefined;
			}
			setWorkerApprovalBroker(worker.session.sessionId, undefined);

			const newSession = yield* createSessionForModel(
				worker.infra,
				spec,
				worker.parentModel,
				worker.infra.modelRegistry,
			).pipe(
				Effect.mapError((err) =>
					err instanceof Error ? err.message : String(err),
				),
			);

			worker.session = newSession;
			worker.agentContext.parentSessionId = newSession.sessionId;
			wireSession(
				newSession,
				worker.infra.sandboxConfig,
				worker.infra.approvalBroker,
			);
			if (worker.infra.resultSchema) {
				newSession.agent.streamFn = toolOnlyStreamFn;
			}
			worker.subscribeToSession(newSession);
		});
	}

	private promptSession(
		message: string,
		modelLabel: string,
	): Effect.Effect<void, string> {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const worker = this;
		return Effect.gen(function* () {
			if (worker.session.isStreaming) {
				yield* Effect.tryPromise({
					try: () =>
						worker.session.prompt(message, {
							source: "extension",
							streamingBehavior: "steer",
						}),
					catch: (err) =>
						`${modelLabel}: ${err instanceof Error ? err.message : String(err)}`,
				});
				return;
			}

			yield* Effect.tryPromise({
				try: () =>
					worker.session.prompt(message, {
						source: "extension",
						streamingBehavior: "steer",
					}),
				catch: (err) =>
					`${modelLabel}: ${err instanceof Error ? err.message : String(err)}`,
			});

			const settled = yield* Effect.tryPromise({
				try: () => waitForSessionSettlement(worker.session),
				catch: (err) =>
					`${modelLabel}: ${err instanceof Error ? err.message : String(err)}`,
			});

			if (!settled.ok) {
				return yield* Effect.fail(`${modelLabel}: ${settled.reason}`);
			}
		});
	}

	private failAllModels(errors: readonly string[]): Effect.Effect<void> {
		const reason =
			errors.length === 1
				? (errors[0] ?? "Unknown error")
				: `All models failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`;

		return SubscriptionRef.set(this.statusRef, {
			state: "failed",
			reason,
			turns: this.turns,
			toolCalls: this.toolCalls,
			workedMs: this.workedMs,
			tools: this.tools,
		});
	}

	private tryModelSpec(
		message: string,
		spec: ModelSpec,
		index: number,
	): Effect.Effect<void, string> {
		return index === 0
			? this.promptSession(message, spec.model)
			: this.switchToModel(spec).pipe(
					Effect.flatMap(() => this.promptSession(message, spec.model)),
				);
	}

	private runWithModelFallback(message: string): Effect.Effect<void> {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const worker = this;
		return Effect.gen(function* () {
			const errors: string[] = [];
			let done = false;

			for (let index = 0; index < worker.models.length && !done; index++) {
				const spec = worker.models[index];
				if (!spec) continue;
				const result = yield* Effect.result(worker.tryModelSpec(message, spec, index));
				if (result._tag === "Success") {
					done = true;
				} else {
					errors.push(result.failure);
				}
			}

			if (!done) {
				yield* worker.failAllModels(errors);
			}
		});
	}

	prompt(message: string): Effect.Effect<string, AgentError> {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const worker = this;
		return Effect.gen(function* () {
			const submissionId = `sub-${nanoid(12)}`;
			worker.submitResultRetries = 0;
			worker.structuredOutput = undefined;
			worker.terminalState = undefined;

			yield* SubscriptionRef.set(worker.statusRef, worker.currentRunningStatus());

			Effect.runFork(
				worker.runWithModelFallback(message).pipe(
					Effect.catch((err: unknown) => {
						const reason = err instanceof Error ? err.message : String(err);
						return SubscriptionRef.set(worker.statusRef, {
							state: "failed",
							reason,
							turns: worker.turns,
							toolCalls: worker.toolCalls,
							workedMs: worker.workedMs,
							tools: worker.tools,
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
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const worker = this;
		return Effect.gen(function* () {
			yield* Effect.promise(() => worker.session.abort());
			if (worker.sessionUnsubscribe) {
				worker.sessionUnsubscribe();
				worker.sessionUnsubscribe = undefined;
			}
			setWorkerApprovalBroker(worker.session.sessionId, undefined);
			worker.terminalState = "shutdown";
			yield* SubscriptionRef.set(worker.statusRef, { state: "shutdown" });
		});
	}

	get status(): Effect.Effect<Status> {
		return SubscriptionRef.get(this.statusRef);
	}

	subscribeStatus(): Stream.Stream<Status> {
		return SubscriptionRef.changes(this.statusRef);
	}
}

/** Create a session for a specific ModelSpec. Used in make() (Effect context). */
function createSessionForModel(
	infra: SessionInfra,
	spec: ModelSpec,
	parentModel: Model<Api> | undefined,
	modelRegistry: ModelRegistry,
): Effect.Effect<AgentSession, AgentError> {
	return Effect.gen(function* () {
		const resolvedModel =
			spec.model !== "inherit"
				? resolveModelPattern(spec.model, modelRegistry.getAll())
				: parentModel;

		const sessionOpts = {
			cwd: infra.cwd,
			authStorage: infra.authStorage,
			modelRegistry,
			sessionManager: SessionManager.inMemory(infra.cwd),
			settingsManager: infra.settingsManager,
			resourceLoader: infra.resourceLoader,
			customTools: infra.customTools,
			...(resolvedModel ? { model: resolvedModel } : {}),
		};
		const { session } = yield* Effect.promise(() => createAgentSession(sessionOpts));

		yield* applyAgentToolAllowlist(session, infra.definition, infra.resultSchema);

		// Apply thinking level
		const thinkingLevel = spec.thinking;
		if (thinkingLevel && thinkingLevel !== "inherit") {
			session.setThinkingLevel(thinkingLevel as ThinkingLevel);
		}

		return session;
	});
}

/** Wire sandbox config and approval broker onto a session. */
function wireSession(
	session: AgentSession,
	sandboxConfig: ResolvedSandboxConfig,
	approvalBroker: ApprovalBroker | undefined,
): void {
	const persisted = loadPersistedState({
		sessionManager: session.sessionManager,
	});
	const next = withWorkerSandboxOverride(persisted, sandboxConfig);
	session.sessionManager.appendCustomEntry(TAU_PERSISTED_STATE_TYPE, next);
	setWorkerApprovalBroker(session.sessionId, approvalBroker);
}
