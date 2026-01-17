import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { TaskRegistry } from "./registry.js";
import { loadSkills } from "./skills.js";
import { SessionManager } from "./sessions.js";
import { TaskRunner } from "./runner.js";
import type { Complexity } from "./types.js";
import { renderTaskCall, renderTaskResult, type TaskBatchItemDetails, type TaskToolDetails } from "./render.js";

const Ajv = (AjvModule as any).default || AjvModule;
const addFormats = (addFormatsModule as any).default || addFormatsModule;
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const BUNDLED_SKILLS = [
	{ name: "task-delegation", relativePath: "../skills/task-delegation/SKILL.md" },
	{ name: "task-type-creation", relativePath: "../skills/task-type-creation/SKILL.md" },
] as const;

type BundledSkill = (typeof BUNDLED_SKILLS)[number];

function ensureBundledSkill(skill: BundledSkill): void {
	const baseSkillsDir = path.join(os.homedir(), ".pi", "agent", "skills");
	const userSkillsDir = path.join(baseSkillsDir, skill.name);
	const destFile = path.join(userSkillsDir, "SKILL.md");
	const altFile = path.join(baseSkillsDir, `${skill.name}.md`);
	if (fs.existsSync(destFile) || fs.existsSync(altFile)) return;

	try {
		const sourceFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), skill.relativePath);
		if (!fs.existsSync(sourceFile)) return;
		fs.mkdirSync(userSkillsDir, { recursive: true });
		fs.copyFileSync(sourceFile, destFile);
	} catch {
		// Ignore install failures
	}
}

function ensureBundledSkills(): void {
	for (const skill of BUNDLED_SKILLS) {
		ensureBundledSkill(skill);
	}
}

function validateOutputSchema(schema: unknown): { ok: true } | { ok: false; error: string } {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
		return { ok: false, error: "result_schema must be a JSON schema object" };
	}
	try {
		ajv.compile(schema as any);
		return { ok: true };
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
}

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	contextTokens: 0,
	turns: 0,
};

function summarizeBatch(results: TaskBatchItemDetails[]): string {
	const total = results.length;
	const counts = { completed: 0, failed: 0, interrupted: 0, running: 0 };
	for (const result of results) {
		counts[result.status]++;
	}
	const parts: string[] = [];
	if (counts.completed) parts.push(`${counts.completed} completed`);
	if (counts.failed) parts.push(`${counts.failed} failed`);
	if (counts.interrupted) parts.push(`${counts.interrupted} interrupted`);
	if (counts.running) parts.push(`${counts.running} running`);
	return parts.length > 0 ? `${parts.join(", ")} of ${total}` : `0 of ${total}`;
}

function aggregateBatchStatus(results: TaskBatchItemDetails[]): TaskBatchItemDetails["status"] {
	if (results.some((r) => r.status === "running")) return "running";
	if (results.some((r) => r.status === "failed")) return "failed";
	if (results.some((r) => r.status === "interrupted")) return "interrupted";
	return "completed";
}

function buildToolDescription(registry: TaskRegistry): string {
	const lines: string[] = [];
	lines.push("Delegate a task to a worker pi process (task-based, not persona-based).\n");
	lines.push("## Task types");
	for (const t of registry.list()) {
		lines.push(`- ${t.name}: ${t.description || ""}`.trim());
	}
	lines.push("");
	lines.push("## Tasks");
	lines.push("- Provide tasks[] array; each entry runs as its own worker");
	lines.push("- Use a single-item array to run one task");
	lines.push("");
	lines.push("## Complexity");
	lines.push("- low: straightforward");
	lines.push("- medium: standard (default)");
	lines.push("- high: complex\n");
	lines.push("## Session continuation");
	lines.push("- Provide session_id on each task entry to resume the same worker context");
	lines.push("- Do not reuse the same session_id within a single batch\n");
	lines.push("## Skills");
	lines.push("- Each task entry with type=custom accepts skills[] to inject additional skills");
	lines.push("");
	lines.push("## Structured output");
	lines.push("- Provide result_schema per task to require a submit_result tool call that matches the schema");
	return lines.join("\n").trim();
}

const TaskItem = Type.Object({
	type: Type.String({
		description: "Type of work: code, search, review, planning, custom",
	}),
	description: Type.String({
		description: "Short description of the task (for logging/UI)",
	}),
	prompt: Type.String({
		description: "The full prompt for the worker",
	}),
	complexity: Type.Optional(
		StringEnum(["low", "medium", "high"] as const, {
			description: "Task complexity. low=straightforward, medium=standard (default), high=complex",
			default: "medium",
		}),
	),
	session_id: Type.Optional(
		Type.String({
			description: "Continue an existing task session instead of starting new",
		}),
	),
	skills: Type.Optional(
		Type.Array(Type.String(), {
			description: "Skills to inject (only valid for type=custom)",
		}),
	),
	result_schema: Type.Optional(
		Type.Any({
			description: "JSON schema for structured output; when provided, worker must call submit_result",
		}),
	),
});

const TaskParams = Type.Object({
	tasks: Type.Array(TaskItem, {
		minItems: 1,
		description: "List of tasks to run concurrently. Use a single-item array for one task.",
	}),
});

export default function task(pi: ExtensionAPI) {

	ensureBundledSkills();

	const sessions = new SessionManager();
	const runner = new TaskRunner();

	// Track how many task tool calls are requested per turn to inject parallel constraints.
	let plannedTaskCalls = 0;
	let activeTaskCalls = 0;

	pi.on("turn_start", async () => {
		plannedTaskCalls = 0;
		activeTaskCalls = 0;
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName === "task") {
			const tasks = Array.isArray((event.input as any).tasks) ? (event.input as any).tasks : undefined;
			const count = Array.isArray(tasks) && tasks.length > 0 ? tasks.length : 1;
			plannedTaskCalls += count;
		}
	});

	pi.registerTool({
		name: "task",
		label: "task",
		description: buildToolDescription(TaskRegistry.load(process.cwd())),
		parameters: TaskParams,

		async execute(_toolCallId, params, onUpdate, ctx, signal) {
			const tasks = Array.isArray((params as any).tasks) ? (params as any).tasks : [];
			if (tasks.length === 0) {
				const details: TaskToolDetails = { status: "failed", results: [], message: "No tasks provided" };
				return {
					content: [{ type: "text", text: "No tasks provided." }],
					isError: true,
					details,
				};
			}

			const registry = TaskRegistry.load(ctx.cwd);
			const availableTypes = registry.list().map((t) => t.name).join(", ");
			const sessionIdCounts = new Map<string, number>();
			for (const task of tasks) {
				const sessionId = typeof task.session_id === "string" ? task.session_id : undefined;
				if (sessionId) sessionIdCounts.set(sessionId, (sessionIdCounts.get(sessionId) || 0) + 1);
			}

			const results: TaskBatchItemDetails[] = tasks.map((task, index) => ({
				index,
				type: typeof task.type === "string" ? task.type.trim() : "",
				complexity: typeof task.complexity === "string" ? task.complexity : "medium",
				description: typeof task.description === "string" ? task.description.trim() : undefined,
				sessionId: typeof task.session_id === "string" ? task.session_id : undefined,
				status: "running",
				model: undefined,
				usage: { ...EMPTY_USAGE },
				activities: [],
				message: undefined,
				missingSkills: undefined,
				loadedSkills: undefined,
				outputType: undefined,
				structuredOutput: undefined,
				durationMs: undefined,
			}));

			const emitBatchUpdate = () => {
				if (!onUpdate) return;
				const summary = summarizeBatch(results);
				onUpdate({
					content: [{ type: "text", text: summary || "(running...)" }],
					details: {
						status: aggregateBatchStatus(results),
						results: results.map((item) => ({ ...item })),
						message: summary,
					} satisfies TaskToolDetails,
				});
			};

			const updateItem = (index: number, patch: Partial<TaskBatchItemDetails>) => {
				results[index] = { ...results[index], ...patch };
				emitBatchUpdate();
			};

			emitBatchUpdate();

			// Give the runtime a tick to emit any additional tool_call events for this turn,
			// so plannedTaskCalls reflects the full parallel batch.
			await new Promise((r) => setTimeout(r, 0));

			const parallelCount = Math.max(1, plannedTaskCalls || tasks.length, activeTaskCalls + tasks.length);
			activeTaskCalls += tasks.length;

			const runTask = async (task: any, index: number) => {
				const taskType = (task.type || "").trim();
				const description = (task.description || "").trim();
				const prompt = task.prompt || "";
				const complexity = (task.complexity || "medium") as Complexity;
				const outputSchema = task.result_schema as unknown;
				const outputSchemaKey = outputSchema ? JSON.stringify(outputSchema) : undefined;
				const taskSessionId = typeof task.session_id === "string" ? task.session_id : undefined;

				updateItem(index, { type: taskType, complexity, description, sessionId: taskSessionId });

				if (taskSessionId && (sessionIdCounts.get(taskSessionId) || 0) > 1) {
					updateItem(index, {
						status: "failed",
						message: `session_id ${taskSessionId} is duplicated in this batch`,
						usage: { ...EMPTY_USAGE },
						activities: [],
						outputType: "failed",
					});
					return;
				}

				if (!registry.get(taskType)) {
					updateItem(index, {
						status: "failed",
						message: `Unknown type: ${taskType}. Available: ${availableTypes}`,
						usage: { ...EMPTY_USAGE },
						activities: [],
						outputType: "failed",
					});
					return;
				}

				if (task.skills && taskType !== "custom") {
					updateItem(index, {
						status: "failed",
						message: "skills is only valid for type=custom",
						usage: { ...EMPTY_USAGE },
						activities: [],
						outputType: "failed",
					});
					return;
				}

				if (outputSchema !== undefined) {
					const validation = validateOutputSchema(outputSchema);
					if (!validation.ok) {
						updateItem(index, {
							status: "failed",
							message: `Invalid result_schema: ${validation.error}`,
							usage: { ...EMPTY_USAGE },
							activities: [],
							outputType: "failed",
						});
						return;
					}
				}

				let policy = registry.resolve(taskType, complexity);
				if (taskType === "custom" && Array.isArray(task.skills)) {
					policy.skills.push(...task.skills);
					// de-dupe
					policy.skills = Array.from(new Set(policy.skills.map((s: string) => s.trim()).filter(Boolean)));
				}

				if (taskSessionId && !sessions.hasSession(taskSessionId)) {
					updateItem(index, {
						status: "failed",
						message: `Unknown session_id: ${taskSessionId}. Omit session_id to start a new task session.`,
						usage: { ...EMPTY_USAGE },
						activities: [],
						outputType: "failed",
					});
					return;
				}

				const { loaded, missing } = loadSkills(policy.skills, ctx.cwd);
				const loadedSkillsMeta = loaded.map((s) => ({ name: s.name, path: s.path }));

				if (missing.length > 0) {
					updateItem(index, {
						status: "failed",
						message: `Missing skills: ${missing.join(", ")}`,
						usage: { ...EMPTY_USAGE },
						activities: [],
						missingSkills: missing,
						loadedSkills: loadedSkillsMeta,
						outputType: "failed",
					});
					return;
				}

				let session: ReturnType<SessionManager["createSession"]>;
				try {
					session = sessions.createSession(taskType, complexity, taskSessionId, outputSchemaKey);
				} catch (err) {
					updateItem(index, {
						status: "failed",
						message: (err as Error).message,
						usage: { ...EMPTY_USAGE },
						activities: [],
						outputType: "failed",
					});
					return;
				}

				const wrapUpdate = (partial: AgentToolResult<any>) => {
					const d = partial.details as any;
					updateItem(index, {
						type: taskType,
						complexity,
						description,
						sessionId: d.sessionId ?? session.sessionId,
						status: d.status,
						model: d.model,
						usage: d.usage,
						activities: d.activities,
						message: d.message,
						missingSkills: missing,
						loadedSkills: loadedSkillsMeta,
					});
				};

				let res;
				try {
					res = await runner.run({
						parentCwd: ctx.cwd,
						parentSessionId: ctx.sessionManager.getSessionId(),
						parentModelId: ctx.model?.id,
						parentThinking: pi.getThinkingLevel(),
						parentTools: pi.getActiveTools(),
						policy,
						sessionId: session.sessionId,
						description,
						prompt,
						skills: loaded,
						parallelCount,
						outputSchema,
						onUpdate: wrapUpdate,
						signal,
					});
				} catch (err) {
					updateItem(index, {
						status: "failed",
						message: (err as Error).message,
						usage: { ...EMPTY_USAGE },
						activities: [],
						outputType: "failed",
					});
					return;
				}

				const outputType = res.output.type;
				const structuredOutput = outputType === "completed_structured" ? res.output.data : undefined;
				const structuredText =
					structuredOutput !== undefined ? JSON.stringify(structuredOutput, null, 2) : "";
				const message =
					outputType === "completed"
						? res.output.message
						: outputType === "completed_tool"
							? res.output.toolOutput
							: outputType === "completed_structured"
								? structuredText
								: outputType === "failed"
									? res.output.reason
									: "";
				const finalMessage =
					message ||
					(outputType === "completed_empty"
						? "(no output)"
						: outputType === "interrupted"
							? "(interrupted; resumable)"
							: "");

				updateItem(index, {
					sessionId: res.sessionId,
					durationMs: res.durationMs,
					status:
						outputType === "completed" ||
						outputType === "completed_tool" ||
						outputType === "completed_structured" ||
						outputType === "completed_empty"
							? "completed"
							: outputType === "interrupted"
								? "interrupted"
								: "failed",
					model: res.model,
					usage: res.usage,
					activities: res.activities,
					message: finalMessage,
					missingSkills: missing,
					loadedSkills: loadedSkillsMeta,
					outputType,
					structuredOutput,
				});
			};

			try {
				await Promise.all(
					tasks.map((task, index) =>
						runTask(task, index).catch((err) => {
							updateItem(index, {
								status: "failed",
								message: (err as Error).message,
								usage: { ...EMPTY_USAGE },
								activities: [],
								outputType: "failed",
							});
						}),
					),
				);
			} finally {
				activeTaskCalls = Math.max(0, activeTaskCalls - tasks.length);
			}

			const summary = summarizeBatch(results);
			const payload = results.map((item) => ({
				type: item.type,
				complexity: item.complexity,
				session_id: item.sessionId ?? null,
				status: item.status,
				output_type: item.status,
				message: item.message ?? "",
				structured_output: item.structuredOutput ?? undefined,
			}));

			const details: TaskToolDetails = {
				status: aggregateBatchStatus(results),
				results: results.map((item) => ({ ...item })),
				message: summary,
			};

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(payload, null, 2),
					},
				],
				details,
				isError: results.some((item) => item.status === "failed"),
			};
		},

		renderCall(args, theme) {
			return renderTaskCall(args, theme);
		},
		renderResult(result, options, theme) {
			return renderTaskResult(result as any, options, theme);
		},
	});
}
