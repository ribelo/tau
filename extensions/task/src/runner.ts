import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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
	| { type: "completed_empty" }
	| { type: "interrupted"; resumable: true }
	| { type: "failed"; reason: string; resumable: boolean };

export interface TaskResult {
	output: TaskOutput;
	sessionId: string;
	usage: UsageStats;
	model?: string;
	messages: Message[];
	activities: Array<{ name: string; args: Record<string, unknown> }>;
}

export type TaskRunnerUpdateDetails = {
	taskType: string;
	difficulty: Difficulty;
	description: string;
	sessionId: string;
	status: "running" | "completed" | "failed" | "interrupted";
	model?: string;
	usage: UsageStats;
	activities: Array<{ name: string; args: Record<string, unknown> }>;
	message?: string;
};

type OnUpdateCallback = (partial: AgentToolResult<TaskRunnerUpdateDetails>) => void;

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type === "text") return part.text;
		}
	}
	return "";
}

function extractActivities(messages: Message[]): Array<{ name: string; args: Record<string, unknown> }> {
	const out: Array<{ name: string; args: Record<string, unknown> }> = [];
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type === "toolCall") {
				out.push({ name: part.name, args: part.arguments as Record<string, unknown> });
			}
		}
	}
	return out;
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

export class TaskRunner {
	constructor(private pi: ExtensionAPI) {}

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
		const usage = emptyUsage();
		const messages: Message[] = [];

		const resolvedModel = options.policy.model ?? options.parentModelId;
		const resolvedThinking = options.policy.thinking ?? (options.parentThinking as any);

		// tools: explicit for all task types so "all tools" really means "current tools".
		// Exclude the task tool itself to avoid runaway recursion.
		const tools = (options.policy.tools ?? options.parentTools).filter((t) => t !== "task");

		const systemPrompt = buildWorkerSystemPrompt({
			parentSessionId: options.parentSessionId,
			parallelCount: options.parallelCount,
			skills: options.skills,
		});

		const tmp = writePromptToTempFile(options.sessionId, systemPrompt);
		let proc: ChildProcess | null = null;
		let buffer = "";
		let stderr = "";
		let exitCode = -1;
		let aborted = false;

		const emit = (status: TaskRunnerUpdateDetails["status"]) => {
			if (!options.onUpdate) return;
			options.onUpdate({
				content: [{ type: "text", text: getFinalOutput(messages) || "(running...)" }],
				details: {
					taskType: options.policy.taskType,
					difficulty: options.policy.difficulty,
					description: options.description,
					sessionId: options.sessionId,
					status,
					model: resolvedModel,
					usage: { ...usage },
					activities: extractActivities(messages),
					message: getFinalOutput(messages) || undefined,
				},
			});
		};

		try {
			emit("running");

			const args: string[] = [
				"--mode",
				"json",
				"-p",
				"--session",
				options.sessionFile,
				"--no-skills",
				"--append-system-prompt",
				tmp.filePath,
				"--tools",
				tools.join(","),
			];

			if (resolvedModel) args.push("--model", resolvedModel);
			if (resolvedThinking) args.push("--thinking", String(resolvedThinking));

			// Forward sandbox choice if the parent was launched with it.
			if ((this.pi.getFlag("no-sandbox") as boolean | undefined) === true) {
				args.push("--no-sandbox");
			}

			args.push(`Task: ${options.prompt}`);

			await new Promise<void>((resolve) => {
				proc = spawn("pi", args, {
					cwd: options.parentCwd,
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

					if (event.type === "message_end" && event.message) {
						const msg = event.message as Message;
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
					}

					if (event.type === "tool_result_end" && event.message) {
						messages.push(event.message as Message);
						emit("running");
					}
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

		const activities = extractActivities(messages);

		if (aborted) {
			emit("interrupted");
			return {
				sessionId: options.sessionId,
				usage,
				model: resolvedModel,
				messages,
				activities,
				output: { type: "interrupted", resumable: true },
			};
		}

		if (exitCode !== 0) {
			const reason = stderr.trim() || getFinalOutput(messages) || `pi exited with code ${exitCode}`;
			emit("failed");
			return {
				sessionId: options.sessionId,
				usage,
				model: resolvedModel,
				messages,
				activities,
				output: { type: "failed", reason, resumable: true },
			};
		}

		const final = getFinalOutput(messages).trim();
		if (!final) {
			emit("completed");
			return {
				sessionId: options.sessionId,
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
			usage,
			model: resolvedModel,
			messages,
			activities,
			output: { type: "completed", message: final },
		};
	}
}
