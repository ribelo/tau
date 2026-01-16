import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Message, Model } from "@mariozechner/pi-ai";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
	SessionManager as SdkSessionManager,
	SettingsManager,
	createAgentSession,
	discoverAuthStorage,
	discoverModels,
	type AgentSession,
	type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import type { Difficulty, ResolvedPolicy } from "./types.js";
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
	difficulty: Difficulty;
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
};

type WorkerBackendOptions = {
	cwd: string;
	parentSessionId: string;
	sessionId: string;
	sessionFile: string;
	prompt: string;
	systemPrompt: string;
	tools: string[];
	model?: string;
	thinking?: string;
	maxDepth: number;
	onEvent: (event: WorkerEvent) => void;
	onSpawn?: (proc: ChildProcess) => void;
	signal?: AbortSignal;
	noSandbox?: boolean;
};

interface WorkerBackend {
	run(options: WorkerBackendOptions): Promise<WorkerBackendResult>;
}

const MAX_TASK_NESTING = 3;

type WorkerSession = {
	session: AgentSession;
	promptRef: { value: string };
	depth: number;
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

function writePromptToTempFile(sessionId: string, prompt: string): { dir: string; filePath: string } {
	const tmpDir = mkdtempSync(path.join(os.tmpdir(), "pi-task-"));
	const safe = sessionId.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safe}.md`);
	writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

function safeCleanup(tmpDir: string) {
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
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
	return { authStorage, modelRegistry, sessions };
})();

class InProcessWorkerBackend implements WorkerBackend {
	async run(options: WorkerBackendOptions): Promise<WorkerBackendResult> {
		const existing = inProcessRuntime.sessions.get(options.sessionId);
		if (!existing) {
			const parentDepth = inProcessRuntime.sessions.get(options.parentSessionId)?.depth ?? 0;
			const depth = parentDepth + 1;
			if (depth > options.maxDepth) {
				return {
					status: "failed",
					error: `Max task nesting depth (${options.maxDepth}) exceeded`,
				};
			}

			const promptRef = { value: options.systemPrompt };
			const resolvedModel = options.model
				? resolveModelPattern(options.model, inProcessRuntime.modelRegistry.getAll())
				: undefined;
			if (options.model && !resolvedModel) {
				return { status: "failed", error: `Unknown model: ${options.model}` };
			}

			const { session } = await createAgentSession({
				cwd: options.cwd,
				authStorage: inProcessRuntime.authStorage,
				modelRegistry: inProcessRuntime.modelRegistry,
				sessionManager: SdkSessionManager.inMemory(options.cwd),
				settingsManager: SettingsManager.inMemory(),
				systemPrompt: (defaultPrompt) => `${defaultPrompt}\n\n${promptRef.value}`,
				skills: [],
				model: resolvedModel,
			});

			inProcessRuntime.sessions.set(options.sessionId, { session, promptRef, depth });
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
			if (aborted) return { status: "aborted" };
			return { status: "failed", error: (err as Error).message };
		} finally {
			unsubscribe();
			if (options.signal) options.signal.removeEventListener("abort", abortRun);
		}

		return { status: aborted ? "aborted" : "completed" };
	}
}

class SubprocessWorkerBackend implements WorkerBackend {
	constructor(private pi: ExtensionAPI) {}

	async run(options: WorkerBackendOptions): Promise<WorkerBackendResult> {
		const tmp = writePromptToTempFile(options.sessionId, options.systemPrompt);
		let proc: ChildProcess | null = null;
		let buffer = "";
		let stderr = "";
		let exitCode = -1;
		let aborted = false;

		const forward = (event: any) => {
			if (event.type === "message_end" && event.message) {
				options.onEvent({ message: event.message as Message });
			}

			if (event.type === "tool_result_end" && event.message) {
				options.onEvent({ message: event.message as Message });
			}
		};

		try {
			const args: string[] = [
				"--mode",
				"json",
				"-p",
				"--session",
				options.sessionFile,
				"--no-skills",
				"--append-system-prompt",
				tmp.filePath,
			];

			if (options.tools.length > 0) {
				args.push("--tools", options.tools.join(","));
			}

			if (options.model) args.push("--model", options.model);
			if (options.thinking) args.push("--thinking", String(options.thinking));
			if (options.noSandbox) args.push("--no-sandbox");

			args.push(`Task: ${options.prompt}`);

			await new Promise<void>((resolve) => {
				proc = spawn("pi", args, {
					cwd: options.cwd,
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
				});
				if (proc) options.onSpawn?.(proc);

				const processLine = (line: string) => {
					if (!line.trim()) return;
					let event: any;
					try {
						event = JSON.parse(line);
					} catch {
						return;
					}

					forward(event);
				};

				proc.stdout?.on("data", (data) => {
					buffer += data.toString();
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";
					for (const l of lines) processLine(l);
				});

				proc.stderr?.on("data", (data) => {
					stderr += data.toString();
				});

				proc.on("close", (code) => {
					exitCode = code ?? 0;
					if (buffer.trim()) processLine(buffer);
					resolve();
				});

				proc.on("error", () => {
					exitCode = 1;
					resolve();
				});

				if (options.signal) {
					const killProc = () => {
						aborted = true;
						try {
							proc?.kill("SIGTERM");
						} catch {
							// ignore
						}
						setTimeout(() => {
							try {
								if (proc && !proc.killed) proc.kill("SIGKILL");
							} catch {
								// ignore
							}
						}, 5000);
					};

					if (options.signal.aborted) killProc();
					else options.signal.addEventListener("abort", killProc, { once: true });
				}
			});
		} finally {
			safeCleanup(tmp.dir);
		}

		if (aborted) return { status: "aborted" };
		if (exitCode !== 0) {
			return {
				status: "failed",
				error: stderr.trim() || `pi exited with code ${exitCode}`,
			};
		}

		return { status: "completed" };
	}
}

export class TaskRunner {
	constructor(
		private pi: ExtensionAPI,
		private backend: WorkerBackend = new InProcessWorkerBackend(),
	) {}

	async run(options: {
		parentCwd: string;
		parentSessionId: string;
		parentModelId?: string;
		parentThinking: string;
		parentTools: string[];
		policy: ResolvedPolicy;
		sessionId: string;
		sessionFile: string;
		description: string;
		prompt: string;
		skills: LoadedSkill[];
		parallelCount: number;
		onUpdate?: OnUpdateCallback;
		onSpawn?: (proc: ChildProcess) => void;
		signal?: AbortSignal;
	}): Promise<TaskResult> {
		const startedAt = Date.now();
		const usage = emptyUsage();
		const messages: Message[] = [];

		const resolvedModel = options.policy.model ?? options.parentModelId;
		const resolvedThinking = options.policy.thinking ?? (options.parentThinking as any);

		// tools: explicit for all task types so "all tools" really means "current tools".
		const tools = Array.from(new Set((options.policy.tools ?? options.parentTools).filter(Boolean)));

		const systemPrompt = buildWorkerSystemPrompt({
			parentSessionId: options.parentSessionId,
			parallelCount: options.parallelCount,
			skills: options.skills,
		});

		const emit = (status: TaskRunnerUpdateDetails["status"]) => {
			if (!options.onUpdate) return;
			const latest = getLatestTextOnly(messages);
			options.onUpdate({
				content: [{ type: "text", text: latest || "(running...)" }],
				details: {
					taskType: options.policy.taskType,
					difficulty: options.policy.difficulty,
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
				sessionFile: options.sessionFile,
				prompt: options.prompt,
				systemPrompt,
				tools,
				model: resolvedModel,
				thinking: resolvedThinking,
				maxDepth: MAX_TASK_NESTING,
				onEvent: handleEvent,
				onSpawn: options.onSpawn,
				signal: options.signal,
				noSandbox: (this.pi.getFlag("no-sandbox") as boolean | undefined) === true,
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
