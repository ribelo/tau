import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { TaskRegistry } from "./registry.js";
import { loadSkills } from "./skills.js";
import { SessionManager } from "./sessions.js";
import { TaskRunner } from "./runner.js";
import type { Difficulty } from "./types.js";
import { renderTaskCall, renderTaskResult, type TaskToolDetails } from "./render.js";

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
	lines.push("- task_type=general accepts a skills[] parameter to inject additional skills");
	return lines.join("\n").trim();
}

const TaskParams = Type.Object({
	task_type: Type.String({
		description: "Type of work: code, search, review, planning, general",
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
			description: "Skills to inject (only valid for task_type=general)",
		}),
	),
});

export default function task(pi: ExtensionAPI) {

	const sessions = new SessionManager();
	const runner = new TaskRunner(pi);

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

			if (params.skills && taskType !== "general") {
				return {
					content: [
						{
							type: "text",
							text: "skills is only valid for task_type=general",
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

			let policy = registry.resolve(taskType, difficulty);
			if (taskType === "general" && Array.isArray(params.skills)) {
				policy.skills.push(...params.skills);
				// de-dupe
				policy.skills = Array.from(new Set(policy.skills.map((s) => s.trim()).filter(Boolean)));
			}

			const session = sessions.createSession(taskType, difficulty, params.session_id);

			const { loaded, missing } = loadSkills(policy.skills, ctx.cwd);
			const loadedSkillsMeta = loaded.map((s) => ({ name: s.name, path: s.path }));

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
					sessionFile: session.sessionFile,
					description,
					prompt,
					skills: loaded,
					parallelCount,
					onUpdate: wrapUpdate,
					onSpawn: (proc) => sessions.setProcess(session.sessionId, proc),
					signal,
				});

				sessions.setProcess(session.sessionId, undefined);

				const outputType = res.output.type;
				const message = res.output.type === "completed" ? res.output.message : outputType === "failed" ? res.output.reason : "";

				const details: TaskToolDetails = {
					taskType,
					difficulty,
					description,
					sessionId: res.sessionId,
					status: outputType === "completed" || outputType === "completed_empty" ? "completed" : outputType === "interrupted" ? "interrupted" : "failed",
					model: res.model,
					usage: res.usage,
					activities: res.activities,
					message,
					missingSkills: missing,
					loadedSkills: loadedSkillsMeta,
					outputType,
				};

				const isError = outputType === "failed";
				return {
					content: [
						{
							type: "json",
							json: {
								session_id: res.sessionId,
								output: res.output,
								usage: res.usage,
								model: res.model,
								missing_skills: missing,
							},
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
