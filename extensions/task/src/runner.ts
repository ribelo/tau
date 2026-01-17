import { stream, streamSimple, type Api, type Message, type Model, type SimpleStreamOptions } from "@mariozechner/pi-ai";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
	SessionManager as SdkSessionManager,
	SettingsManager,
	createAgentSession,
	discoverAuthStorage,
	discoverModels,
	type AgentSession,
	type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { Complexity, ResolvedPolicy } from "./types.js";
import type { LoadedSkill } from "./skills.js";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export type TaskOutput =
	| { type: "completed"; message: string }
	| { type: "completed_tool"; toolOutput: string }
	| { type: "completed_structured"; data: unknown }
	| { type: "completed_empty" }
	| { type: "interrupted"; resumable: true }
	| { type: "failed"; reason: string; resumable: boolean };

export interface TaskResult {
	output: TaskOutput;
	sessionId: string;
	durationMs: number;
	usage: UsageStats;
	model?: string;
	messages: Message[];
	activities: TaskActivity[];
}

export type TaskRunnerUpdateDetails = {
	taskType: string;
	complexity: Complexity;
	description: string;
	sessionId: string;
	durationMs: number;
	status: "running" | "completed" | "failed" | "interrupted";
	model?: string;
	usage: UsageStats;
	activities: TaskActivity[];
	message?: string;
};

type OnUpdateCallback = (partial: AgentToolResult<TaskRunnerUpdateDetails>) => void;

type WorkerEvent = { message: Message };

type WorkerBackendResult = {
	status: "completed" | "failed" | "aborted";
	error?: string;
	structuredOutput?: unknown;
};

type WorkerBackendOptions = {
	cwd: string;
	parentSessionId: string;
	sessionId: string;
	prompt: string;
	systemPrompt: string;
	tools: string[];
	model?: string;
	thinking?: string;
	maxDepth: number;
	outputSchema?: Record<string, unknown>;
	onEvent: (event: WorkerEvent) => void;
	signal?: AbortSignal;
};

interface WorkerBackend {
	run(options: WorkerBackendOptions): Promise<WorkerBackendResult>;
}

const MAX_TASK_NESTING = 3;

type WorkerSession = {
	session: AgentSession;
	promptRef: { value: string };
	depth: number;
	outputSchemaKey?: string;
	structuredRef?: { value?: unknown };
	submittedRef?: { value: boolean };
};

function resolveModelPattern(pattern: string, models: Model<Api>[]): Model<Api> | undefined {
	const trimmed = pattern.trim();
	if (!trimmed) return undefined;

	const slashIndex = trimmed.indexOf("/");
	if (slashIndex !== -1) {
		const provider = trimmed.slice(0, slashIndex).toLowerCase();
		const modelId = trimmed.slice(slashIndex + 1).toLowerCase();
		const match = models.find(
			(m) => m.provider.toLowerCase() === provider && m.id.toLowerCase() === modelId,
		);
		if (match) return match;
	}

	const exact = models.find((m) => m.id.toLowerCase() === trimmed.toLowerCase());
	if (exact) return exact;

	const partial = models.find(
		(m) => m.id.toLowerCase().includes(trimmed.toLowerCase()) || m.name?.toLowerCase().includes(trimmed.toLowerCase()),
	);
	return partial;
}

const TOOL_CHOICE_APIS = new Set([
	"anthropic-messages",
	"openai-completions",
	"google-generative-ai",
	"google-vertex",
	"google-gemini-cli",
	"bedrock-converse-stream",
	"amazon-bedrock",
]);

function createSubmitTool(
	schema: Record<string, unknown>,
	target: { value?: unknown },
	submitted: { value: boolean },
	onSubmit?: () => void,
): ToolDefinition {
	return {
		name: "submit_result",
		label: "submit_result",
		description: "Submit structured result for the task",
		parameters: Type.Unsafe(schema as any),
		async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
			if (signal?.aborted) {
				throw new Error("submit_result aborted");
			}
			if (submitted.value) {
				return {
					content: [{ type: "text", text: "Result already submitted." }],
					details: { ok: false, duplicate: true },
				};
			}
			submitted.value = true;
			target.value = params;
			onSubmit?.();
			return {
				content: [{ type: "text", text: "Result received." }],
				details: { ok: true },
			};
		},
	};
}

function toolOnlyStreamFn(model: Model<Api>, context: any, options?: SimpleStreamOptions) {
	const base = {
		temperature: options?.temperature,
		maxTokens: options?.maxTokens || Math.min(model.maxTokens, 32000),
		signal: options?.signal,
		apiKey: (options as any)?.apiKey,
		sessionId: options?.sessionId,
	};

	switch (model.api) {
		case "anthropic-messages":
			return stream(model as any, context, { ...base, thinkingEnabled: false, toolChoice: "any" } as any);
		case "openai-completions":
			return stream(model as any, context, { ...base, toolChoice: "required" } as any);
		case "google-generative-ai":
			return stream(model as any, context, { ...base, toolChoice: "any", thinking: { enabled: false } } as any);
		case "google-vertex":
			return stream(model as any, context, { ...base, toolChoice: "any", thinking: { enabled: false } } as any);
		case "google-gemini-cli":
			return stream(model as any, context, { ...base, toolChoice: "any", thinking: { enabled: false } } as any);
		case "bedrock-converse-stream":
			return stream(model as any, context, { ...base, toolChoice: "any" } as any);
		case "amazon-bedrock":
			return stream(model as any, context, { ...base, toolChoice: "any" } as any);
		default:
			return streamSimple(model as any, context, options);
	}
}

type LatestText =
	| { source: "assistant"; text: string }
	| { source: "toolResult"; text: string }
	| null;

function getLatestText(messages: Message[]): LatestText {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]!;

		if (msg.role === "assistant") {
			const parts = msg.content
				.filter((p) => p.type === "text")
				.map((p: any) => String(p.text ?? "").trim())
				.filter(Boolean);
			if (parts.length > 0) return { source: "assistant", text: parts.join("\n") };
		}

		if (msg.role === "toolResult") {
			const parts = msg.content
				.filter((p) => p.type === "text")
				.map((p: any) => String(p.text ?? "").trimEnd())
				.filter(Boolean);
			if (parts.length > 0) return { source: "toolResult", text: parts.join("\n") };
		}
	}

	return null;
}

function getLatestTextOnly(messages: Message[]): string {
	return getLatestText(messages)?.text ?? "";
}

export type TaskActivityStatus = "pending" | "success" | "error";

export type TaskActivity = {
	toolCallId: string;
	name: string;
	args: Record<string, unknown>;
	status: TaskActivityStatus;
	/** One-line (or small) text preview of the tool result, if available. */
	resultText?: string;
};

function extractActivities(messages: Message[]): TaskActivity[] {
	const calls: TaskActivity[] = [];
	const byId = new Map<string, TaskActivity>();

	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type !== "toolCall") continue;
				const id = String((part as any).id ?? "");
				if (!id) continue;
				const activity: TaskActivity = {
					toolCallId: id,
					name: part.name,
					args: (part.arguments ?? {}) as Record<string, unknown>,
					status: "pending",
				};
				calls.push(activity);
				byId.set(id, activity);
			}
			continue;
		}

		if (msg.role === "toolResult") {
			const id = String((msg as any).toolCallId ?? "");
			const toolName = String((msg as any).toolName ?? "");
			const isError = Boolean((msg as any).isError);

			const text = Array.isArray(msg.content)
				? msg.content
						.filter((p: any) => p?.type === "text")
						.map((p: any) => String(p.text ?? ""))
						.join("\n")
						.trim()
				: "";

			const existing = byId.get(id);
			if (existing) {
				existing.status = isError ? "error" : "success";
				if (text) existing.resultText = text;
			} else if (id) {
				// Fallback: tool result without a tool call (shouldn't happen, but keep UI stable)
				calls.push({
					toolCallId: id,
					name: toolName || "(tool)",
					args: {},
					status: isError ? "error" : "success",
					resultText: text || undefined,
				});
			}
		}
	}

	return calls;
}

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function buildWorkerSystemPrompt(options: {
	parentSessionId: string;
	parallelCount: number;
	skills: LoadedSkill[];
}): string {
	const lines: string[] = [];
	lines.push("# Task Execution Context");
	lines.push(`You are executing a delegated task from parent session: ${options.parentSessionId}`);
	lines.push("");
	lines.push("## Guidelines");
	lines.push("- Focus on the requested task");
	lines.push("- Use available tools as needed");
	lines.push("- If specific output format required, follow it exactly");
	lines.push("- Otherwise, summarize what you did and why");

	if (options.parallelCount > 1) {
		lines.push("");
		lines.push(`## Parallel Execution (${options.parallelCount} workers)`);
		lines.push(`This parent spawned ${options.parallelCount} task sessions in parallel.`);
		lines.push("- Assume other workers may be editing the repo at the same time.");
		lines.push("- Avoid editing the same files or shared contracts unless explicitly required.");
		lines.push("- Keep changes narrowly scoped to your assigned area.");
		lines.push("- If you detect overlap or a dependency on another worker, stop and report it.");
	}

	if (options.skills.length > 0) {
		lines.push("");
		lines.push("---");
		for (const s of options.skills) {
			lines.push(`<skill name=\"${s.name}\" path=\"${s.path}\">`);
			lines.push(s.contents.trim());
			lines.push("</skill>");
			lines.push("");
		}
	}

	return lines.join("\n").trim() + "\n";
}

const inProcessRuntime = (() => {
	const authStorage = discoverAuthStorage();
	const modelRegistry = discoverModels(authStorage);
	const sessions = new Map<string, WorkerSession>();
	const depthBySessionId = new Map<string, number>();
	return { authStorage, modelRegistry, sessions, depthBySessionId };
})();

class InProcessWorkerBackend implements WorkerBackend {
	async run(options: WorkerBackendOptions): Promise<WorkerBackendResult> {
		const existing = inProcessRuntime.sessions.get(options.sessionId);
		const outputSchemaKey = options.outputSchema ? JSON.stringify(options.outputSchema) : undefined;
		if (!existing) {
			const parentDepth = inProcessRuntime.depthBySessionId.get(options.parentSessionId) ?? 0;
			const depth = parentDepth + 1;
			if (depth > options.maxDepth) {
				return {
					status: "failed",
					error: `Max task nesting depth (${options.maxDepth}) exceeded`,
				};
			}

			const promptRef = { value: options.systemPrompt };
			const structuredRef = { value: undefined as unknown };
			const submittedRef = { value: false };
			const resolvedModel = options.model
				? resolveModelPattern(options.model, inProcessRuntime.modelRegistry.getAll())
				: undefined;
			if (options.model && !resolvedModel) {
				return { status: "failed", error: `Unknown model: ${options.model}` };
			}

			let abortAfterSubmit: (() => void) | undefined;
			const customTools = options.outputSchema
				? [createSubmitTool(options.outputSchema, structuredRef, submittedRef, () => abortAfterSubmit?.())]
				: undefined;

			const { session } = await createAgentSession({
				cwd: options.cwd,
				authStorage: inProcessRuntime.authStorage,
				modelRegistry: inProcessRuntime.modelRegistry,
				sessionManager: SdkSessionManager.inMemory(options.cwd),
				settingsManager: SettingsManager.inMemory(),
				systemPrompt: (defaultPrompt) => `${defaultPrompt}\n\n${promptRef.value}`,
				skills: [],
				customTools,
				model: resolvedModel,
			});

			abortAfterSubmit = () => {
				session.abort().catch(() => undefined);
			};

			inProcessRuntime.depthBySessionId.set(session.sessionId, depth);
			inProcessRuntime.sessions.set(options.sessionId, {
				session,
				promptRef,
				depth,
				outputSchemaKey,
				structuredRef: options.outputSchema ? structuredRef : undefined,
				submittedRef: options.outputSchema ? submittedRef : undefined,
			});
		} else {
			if (outputSchemaKey && existing.outputSchemaKey && existing.outputSchemaKey !== outputSchemaKey) {
				return { status: "failed", error: "result_schema does not match existing session" };
			}
			if (!outputSchemaKey && existing.outputSchemaKey) {
				return { status: "failed", error: "result_schema is required for this session" };
			}
			if (outputSchemaKey && !existing.outputSchemaKey) {
				return { status: "failed", error: "result_schema cannot be added to an existing session" };
			}
		}

		const entry = inProcessRuntime.sessions.get(options.sessionId)!;
		entry.promptRef.value = options.systemPrompt;

		const toolList = Array.from(new Set(options.tools.filter(Boolean)));
		entry.session.setActiveToolsByName(toolList);

		if (options.model) {
			const resolvedModel = resolveModelPattern(options.model, inProcessRuntime.modelRegistry.getAll());
			if (!resolvedModel) {
				return { status: "failed", error: `Unknown model: ${options.model}` };
			}

			const current = entry.session.model;
			if (!current || current.provider !== resolvedModel.provider || current.id !== resolvedModel.id) {
				try {
					await entry.session.setModel(resolvedModel);
				} catch (err) {
					return { status: "failed", error: (err as Error).message };
				}
			}
		}

		const activeModel = entry.session.model;
		if (options.outputSchema) {
			if (!activeModel || !TOOL_CHOICE_APIS.has(activeModel.api)) {
				return { status: "failed", error: `Structured output not supported for provider ${activeModel?.provider ?? "unknown"}` };
			}
			entry.session.agent.streamFn = toolOnlyStreamFn;
			if (!entry.structuredRef || !entry.submittedRef) {
				return { status: "failed", error: "Structured output is not configured for this session" };
			}
			entry.structuredRef.value = undefined;
			entry.submittedRef.value = false;
		} else {
			entry.session.agent.streamFn = streamSimple as any;
		}

		if (options.thinking) {
			entry.session.setThinkingLevel(options.thinking as any);
		}

		let aborted = false;
		const abortRun = () => {
			aborted = true;
			entry.session.abort().catch(() => undefined);
		};

		if (options.signal) {
			if (options.signal.aborted) abortRun();
			else options.signal.addEventListener("abort", abortRun, { once: true });
		}

		const unsubscribe = entry.session.subscribe((event) => {
			if (event.type === "message_end") {
				options.onEvent({ message: event.message as Message });
			}
		});

		try {
			await entry.session.prompt(`Task: ${options.prompt}`, { source: "extension" });
		} catch (err) {
			if (options.outputSchema && entry.structuredRef?.value !== undefined) {
				return { status: "completed", structuredOutput: entry.structuredRef.value };
			}
			if (aborted) return { status: "aborted" };
			return { status: "failed", error: (err as Error).message };
		} finally {
			unsubscribe();
			if (options.signal) options.signal.removeEventListener("abort", abortRun);
		}

		if (options.outputSchema) {
			const structured = entry.structuredRef?.value;
			if (structured === undefined) {
				if (aborted) return { status: "aborted" };
				return { status: "failed", error: "submit_result was not called" };
			}
			return { status: "completed", structuredOutput: structured };
		}

		if (aborted) return { status: "aborted" };

		return { status: "completed" };
	}
}

export class TaskRunner {
	constructor(private backend: WorkerBackend = new InProcessWorkerBackend()) {}

	async run(options: {
		parentCwd: string;
		parentSessionId: string;
		parentModelId?: string;
		parentThinking: string;
		parentTools: string[];
		policy: ResolvedPolicy;
		sessionId: string;
		description: string;
		prompt: string;
		skills: LoadedSkill[];
		parallelCount: number;
		outputSchema?: Record<string, unknown>;
		onUpdate?: OnUpdateCallback;
		signal?: AbortSignal;
	}): Promise<TaskResult> {
		const startedAt = Date.now();
		const usage = emptyUsage();
		const messages: Message[] = [];

		const resolvedModel = options.policy.model ?? options.parentModelId;
		const resolvedThinking = options.policy.thinking ?? (options.parentThinking as any);

		// tools: explicit for all task types so "all tools" really means "current tools".
		const baseTools = Array.from(new Set((options.policy.tools ?? options.parentTools).filter(Boolean)));
		const tools = options.outputSchema
			? Array.from(new Set([...baseTools, "submit_result"]))
			: baseTools;

		const basePrompt = buildWorkerSystemPrompt({
			parentSessionId: options.parentSessionId,
			parallelCount: options.parallelCount,
			skills: options.skills,
		});

		const systemPrompt = options.outputSchema
			? `${basePrompt}\n\n## Structured Output\n- You must call submit_result exactly once with JSON matching the provided schema.\n- Do not respond with free text.\n- Stop immediately after calling submit_result.\n\nSchema:\n\n\`\`\`json\n${JSON.stringify(options.outputSchema, null, 2)}\n\`\`\`\n`
			: basePrompt;

		const emit = (status: TaskRunnerUpdateDetails["status"]) => {
			if (!options.onUpdate) return;
			const latest = getLatestTextOnly(messages);
			options.onUpdate({
				content: [{ type: "text", text: latest || "(running...)" }],
				details: {
					taskType: options.policy.taskType,
					complexity: options.policy.complexity,
					description: options.description,
					sessionId: options.sessionId,
					durationMs: Math.max(0, Date.now() - startedAt),
					status,
					model: resolvedModel,
					usage: { ...usage },
					activities: extractActivities(messages),
					message: latest || undefined,
				},
			});
		};

		const handleEvent = (event: WorkerEvent) => {
			const msg = event.message;
			messages.push(msg);

			if (msg.role === "assistant") {
				usage.turns++;
				const u = msg.usage;
				if (u) {
					usage.input += u.input || 0;
					usage.output += u.output || 0;
					usage.cacheRead += u.cacheRead || 0;
					usage.cacheWrite += u.cacheWrite || 0;
					usage.cost += u.cost?.total || 0;
					usage.contextTokens = u.totalTokens || 0;
				}
			}

			emit("running");
		};

		emit("running");

		let backendResult: WorkerBackendResult;
		try {
			backendResult = await this.backend.run({
				cwd: options.parentCwd,
				parentSessionId: options.parentSessionId,
				sessionId: options.sessionId,
				prompt: options.prompt,
				systemPrompt,
				tools,
				model: resolvedModel,
				thinking: resolvedThinking,
				maxDepth: MAX_TASK_NESTING,
				outputSchema: options.outputSchema,
				onEvent: handleEvent,
				signal: options.signal,
			});
		} catch (err) {
			backendResult = { status: "failed", error: (err as Error).message };
		}

		const activities = extractActivities(messages);

		const durationMs = Math.max(0, Date.now() - startedAt);

		if (backendResult.status === "aborted") {
			emit("interrupted");
			return {
				sessionId: options.sessionId,
				durationMs,
				usage,
				model: resolvedModel,
				messages,
				activities,
				output: { type: "interrupted", resumable: true },
			};
		}

		if (backendResult.status === "failed") {
			const reason = backendResult.error || getLatestTextOnly(messages) || "worker failed";
			emit("failed");
			return {
				sessionId: options.sessionId,
				durationMs,
				usage,
				model: resolvedModel,
				messages,
				activities,
				output: { type: "failed", reason, resumable: true },
			};
		}

		if (backendResult.structuredOutput !== undefined) {
			emit("completed");
			return {
				sessionId: options.sessionId,
				durationMs,
				usage,
				model: resolvedModel,
				messages,
				activities,
				output: { type: "completed_structured", data: backendResult.structuredOutput },
			};
		}

		const latest = getLatestText(messages);
		const final = latest?.text.trim() ?? "";
		if (!final) {
			emit("completed");
			return {
				sessionId: options.sessionId,
				durationMs,
				usage,
				model: resolvedModel,
				messages,
				activities,
				output: { type: "completed_empty" },
			};
		}

		emit("completed");
		return {
			sessionId: options.sessionId,
			durationMs,
			usage,
			model: resolvedModel,
			messages,
			activities,
			output:
				latest?.source === "toolResult"
					? { type: "completed_tool", toolOutput: final }
					: { type: "completed", message: final },
		};
	}
}
