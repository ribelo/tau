import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";

import { TaskRegistry } from "./registry.js";
import { loadSkills } from "./skills.js";
import { SessionManager } from "./sessions.js";
import { TaskRunner } from "./runner.js";
import type { Difficulty } from "./types.js";
import { renderTaskCall, renderTaskResult, type TaskToolDetails } from "./render.js";

const Ajv = (AjvModule as any).default || AjvModule;
const addFormats = (addFormatsModule as any).default || addFormatsModule;
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

function validateOutputSchema(schema: unknown): { ok: true } | { ok: false; error: string } {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
		return { ok: false, error: "output_schema must be a JSON schema object" };
	}
	try {
		ajv.compile(schema as any);
		return { ok: true };
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
}

function buildToolDescription(registry: TaskRegistry): string {
	const lines: string[] = [];
	lines.push("Delegate a task to a worker pi process (task-based, not persona-based).\n");
	lines.push("## Task types");
	for (const t of registry.list()) {
		lines.push(`- ${t.name}: ${t.description || ""}`.trim());
	}
	lines.push("");
	lines.push("## Difficulty");
	lines.push("- small: trivial");
	lines.push("- medium: standard (default)");
	lines.push("- large: complex\n");
	lines.push("## Session continuation");
	lines.push("- Provide session_id to resume the same worker context\n");
	lines.push("## Skills");
	lines.push("- task_type=custom accepts a skills[] parameter to inject additional skills");
	lines.push("");
	lines.push("## Structured output");
	lines.push("- Provide output_schema to require a submit_result tool call that matches the schema");
	return lines.join("\n").trim();
}

const TaskParams = Type.Object({
	task_type: Type.String({
		description: "Type of work: code, search, review, planning, custom",
	}),
	description: Type.String({
		description: "Short description of the task (for logging/UI)",
	}),
	prompt: Type.String({
		description: "The full prompt for the worker",
	}),
	difficulty: Type.Optional(
		StringEnum(["small", "medium", "large"] as const, {
			description: "Task complexity. small=trivial, medium=standard (default), large=complex",
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
			description: "Skills to inject (only valid for task_type=custom)",
		}),
	),
	output_schema: Type.Optional(
		Type.Any({
			description: "JSON schema for structured output; when provided, worker must call submit_result",
		}),
	),
});

export default function task(pi: ExtensionAPI) {

	const sessions = new SessionManager();
	const runner = new TaskRunner();

	// Track how many task tool calls are requested per turn to inject parallel constraints.
	let currentTurnIndex = -1;
	let plannedTaskCalls = 0;
	let activeTaskCalls = 0;

	pi.on("turn_start", async (event) => {
		currentTurnIndex = event.turnIndex;
		plannedTaskCalls = 0;
		activeTaskCalls = 0;
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName === "task") {
			plannedTaskCalls++;
		}
	});

	pi.registerTool({
		name: "task",
		label: "task",
		description: buildToolDescription(TaskRegistry.load(process.cwd())),
		parameters: TaskParams,

		async execute(_toolCallId, params, onUpdate, ctx, signal) {
			const taskType = (params.task_type || "").trim();
			const description = (params.description || "").trim();
			const prompt = params.prompt || "";
			const difficulty = (params.difficulty || "medium") as Difficulty;
			const outputSchema = params.output_schema as unknown;
			const outputSchemaKey = outputSchema ? JSON.stringify(outputSchema) : undefined;

			const registry = TaskRegistry.load(ctx.cwd);
			const typeDef = registry.get(taskType);
			if (!typeDef) {
				return {
					content: [
						{
							type: "text",
							text: `Unknown task_type: ${taskType}\nAvailable: ${registry
								.list()
								.map((t) => t.name)
								.join(", ")}`,
						},
					],
					isError: true,
					details: {
						taskType,
						difficulty,
						description,
						sessionId: params.session_id ?? "(none)",
						status: "failed",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						activities: [],
					} satisfies TaskToolDetails,
				};
			}

			if (params.skills && taskType !== "custom") {
				return {
					content: [
						{
							type: "text",
							text: "skills is only valid for task_type=custom",
						},
					],
					isError: true,
					details: {
						taskType,
						difficulty,
						description,
						sessionId: params.session_id ?? "(none)",
						status: "failed",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						activities: [],
					} satisfies TaskToolDetails,
				};
			}

			if (outputSchema !== undefined) {
				const validation = validateOutputSchema(outputSchema);
				if (!validation.ok) {
					return {
						content: [
							{
								type: "text",
								text: `Invalid output_schema: ${validation.error}`,
							},
						],
						isError: true,
						details: {
							taskType,
							difficulty,
							description,
							sessionId: params.session_id ?? "(none)",
							status: "failed",
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
							activities: [],
						} satisfies TaskToolDetails,
					};
				}
			}

			let policy = registry.resolve(taskType, difficulty);
			if (taskType === "custom" && Array.isArray(params.skills)) {
				policy.skills.push(...params.skills);
				// de-dupe
				policy.skills = Array.from(new Set(policy.skills.map((s) => s.trim()).filter(Boolean)));
			}

			if (params.session_id && !sessions.hasSession(params.session_id)) {
				return {
					content: [
						{
							type: "text",
							text: `Unknown session_id: ${params.session_id}. Omit session_id to start a new task session.`,
						},
					],
					isError: true,
					details: {
						taskType,
						difficulty,
						description,
						sessionId: params.session_id,
						status: "failed",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						activities: [],
					} satisfies TaskToolDetails,
				};
			}

			const { loaded, missing } = loadSkills(policy.skills, ctx.cwd);
			const loadedSkillsMeta = loaded.map((s) => ({ name: s.name, path: s.path }));

			if (missing.length > 0) {
				return {
					content: [
						{
							type: "text",
							text: `Missing skills: ${missing.join(", ")}`,
						},
					],
					isError: true,
					details: {
						taskType,
						difficulty,
						description,
						sessionId: params.session_id ?? "(none)",
						status: "failed",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						activities: [],
						missingSkills: missing,
						loadedSkills: loadedSkillsMeta,
					} satisfies TaskToolDetails,
				};
			}

			let session: ReturnType<SessionManager["createSession"]>;
			try {
				session = sessions.createSession(taskType, difficulty, params.session_id, outputSchemaKey);
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: (err as Error).message,
						},
					],
					isError: true,
					details: {
						taskType,
						difficulty,
						description,
						sessionId: params.session_id ?? "(none)",
						status: "failed",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						activities: [],
					} satisfies TaskToolDetails,
				};
			}

			// Give the runtime a tick to emit any additional tool_call events for this turn,
			// so plannedTaskCalls reflects the full parallel batch.
			await new Promise((r) => setTimeout(r, 0));

			const parallelCount = Math.max(1, plannedTaskCalls || 1, activeTaskCalls + 1);
			activeTaskCalls++;

			const wrapUpdate = (partial: AgentToolResult<any>) => {
				if (!onUpdate) return;
				const d = partial.details as any;
				onUpdate({
					...partial,
					details: {
						...d,
						missingSkills: missing,
						loadedSkills: loadedSkillsMeta,
					} satisfies TaskToolDetails,
				});
			};

			try {
				const res = await runner.run({
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

				const details: TaskToolDetails = {
					taskType,
					difficulty,
					description,
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
					message,
					missingSkills: missing,
					loadedSkills: loadedSkillsMeta,
					outputType,
					structuredOutput,
				};

				const isError = outputType === "failed";
				const baseText = (() => {
					if (outputType === "failed") return message ? `ERROR: ${message}` : "ERROR";
					if (outputType === "interrupted") return "(interrupted; resumable)";
					if (outputType === "completed_empty") return "(no output)";
					return message || "(no output)";
				})();

				return {
					content: [
						{
							type: "text",
							text: `${baseText}\n\nsession_id: ${res.sessionId}`,
						},
					],
					details,
					isError,
				};
			} finally {
				activeTaskCalls = Math.max(0, activeTaskCalls - 1);
			}
		},

		renderCall(args, theme) {
			return renderTaskCall(args, theme);
		},
		renderResult(result, options, theme) {
			return renderTaskResult(result as any, options, theme);
		},
	});
}
