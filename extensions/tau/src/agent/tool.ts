import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Effect } from "effect";
import { StringEnum } from "@mariozechner/pi-ai";
import type { Model, Api } from "@mariozechner/pi-ai";
import {
	AgentControl,
	AgentLimitReached,
	AgentDepthExceeded,
	AgentNotFound,
	AgentError,
	type ControlSpawnOptions,
} from "./services.js";
import { AgentRegistry } from "./agent-registry.js";
import type { AgentId } from "./types.js";
import { renderAgentCall, renderAgentResult } from "./render.js";
import type { ApprovalBroker } from "./approval-broker.js";

export const AgentParams = Type.Object({
	action: StringEnum(["spawn", "send", "wait", "close", "list"] as const, {
		description: "Action: spawn (create), send (message existing), wait (block until done), close (terminate), list (show all)",
	}),
	// spawn
	agent: Type.Optional(Type.String({ 
		description: "Agent name to spawn (e.g., oracle, finder, rush, general, review, painter, librarian)" 
	})),
	message: Type.Optional(
		Type.String({ description: "Task instructions for the agent" }),
	),
	complexity: Type.Optional(
		StringEnum(["low", "medium", "high"] as const, {
			description: "Model selection: low (fast/cheap), medium (default), high (capable/expensive)",
		}),
	),
	result_schema: Type.Optional(
		Type.Any({
			description: "JSON schema for structured output. Agent must call submit_result with matching data.",
		}),
	),
	// send/close
	id: Type.Optional(Type.String({ description: "Target agent ID" })),
	interrupt: Type.Optional(
		Type.Boolean({
			description: "If true, abort agent's current work before sending new message",
		}),
	),
	// wait
	ids: Type.Optional(
		Type.Array(Type.String(), { 
			description: "Agent IDs to wait for. Returns when ALL agents finish (completed/failed/shutdown)" 
		}),
	),
	timeout_ms: Type.Optional(
		Type.Number({ 
			description: "Max wait time in ms. Default 900000 (15 min), max 14400000 (4 hours). Returns timedOut:true if exceeded" 
		}),
	),
});

export function buildToolDescription(cwd?: string): string {
	// Load registry to get available agents
	const registry = AgentRegistry.load(cwd ?? process.cwd());
	const agents = registry.list();
	
	const lines: string[] = [];
	lines.push("Manage non-blocking agent tasks. Actions: spawn, send, wait, close, list.");
	lines.push("");
	lines.push("## Workflow");
	lines.push("1. spawn: starts agent in background, returns agent_id immediately");
	lines.push("2. wait: blocks until agent(s) complete, returns their output");
	lines.push("3. Result is in: status.{agent_id}.message");
	lines.push("");
	lines.push("You can spawn multiple agents and wait for all at once.");
	lines.push("");
	lines.push("## Available agents");
	for (const a of agents) {
		// Take first line of description for brevity
		const shortDesc = a.description.split("\n")[0]?.trim() || "";
		lines.push(`- ${a.name}: ${shortDesc}`);
	}
	return lines.join("\n").trim();
}

export interface AgentToolContext {
	parentSessionId: string;
	parentModel: Model<Api> | undefined;
	cwd: string;
	approvalBroker: ApprovalBroker | undefined;
}

export interface AgentToolDef {
	name: string;
	label: string;
	description: string;
	parameters: TSchema;
	execute: (
		toolCallId: string,
		params: unknown,
		onUpdate: unknown,
		ctx: unknown,
		signal?: AbortSignal,
	) => Promise<{
		isError?: boolean;
		content: Array<{ type: "text"; text: string }>;
		details: object;
	}>;
	renderCall?: typeof renderAgentCall;
	renderResult?: typeof renderAgentResult;
}

/**
 * Create an agent tool that uses the provided runtime to execute commands.
 * This allows both the main extension and worker sessions to use the same
 * underlying AgentManager.
 */
export function createAgentToolDef(
	runEffect: <A, E>(effect: Effect.Effect<A, E, AgentControl>) => Promise<A>,
	getContext: () => AgentToolContext,
): AgentToolDef {
	return {
		name: "agent",
		label: "agent",
		description: buildToolDescription(),
		parameters: AgentParams,

		async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
			const context = getContext();
			const program = Effect.gen(function* () {
				const control = yield* AgentControl;
				const p = params as Static<typeof AgentParams>;

				switch (p.action) {
					case "spawn": {
						if (!p.agent || !p.message) {
							return yield* Effect.fail(
								new Error("spawn requires 'agent' and 'message'"),
							);
						}
						const id = yield* control.spawn({
							agent: p.agent,
							message: p.message,
							complexity: p.complexity,
							result_schema: p.result_schema,
							approvalBroker: context.approvalBroker,
							parentSessionId: context.parentSessionId,
							parentModel: context.parentModel,
							cwd: context.cwd,
						} satisfies ControlSpawnOptions as ControlSpawnOptions);
						return { 
							agent_id: id, 
							status: "running",
							message: p.message,
							note: "Agent started. Call wait with this id to get result when done.",
						};
					}
					case "send": {
						if (!p.id || !p.message) {
							return yield* Effect.fail(
								new Error("send requires 'id' and 'message'"),
							);
						}
						const submission_id = yield* control.send(
							p.id as AgentId,
							p.message,
							p.interrupt,
						);
						return { submission_id };
					}
					case "wait": {
						if (!p.ids || p.ids.length === 0) {
							return yield* Effect.fail(new Error("wait requires 'ids'"));
						}
						const result = yield* control.wait(p.ids as AgentId[], p.timeout_ms);
						return result;
					}
					case "close": {
						if (!p.id) {
							return yield* Effect.fail(new Error("close requires 'id'"));
						}
						yield* control.close(p.id as AgentId);
						return { status: "closed" };
					}
					case "list": {
						const agents = yield* control.list;
						return { agents };
					}
					default:
						return yield* Effect.fail(new Error(`Unknown action: ${p.action}`));
				}
			});

			try {
				const result = await runEffect(
					program.pipe(
						Effect.catchTags({
							AgentLimitReached: (err: AgentLimitReached) =>
								Effect.fail(new Error(`Agent limit reached (max: ${err.max}). Wait for existing agents to finish or close them.`)),
							AgentDepthExceeded: (err: AgentDepthExceeded) =>
								Effect.fail(new Error(`Agent depth exceeded (max: ${err.max}). Deeply nested agent spawns are restricted.`)),
							AgentNotFound: (err: AgentNotFound) =>
								Effect.fail(new Error(`Agent not found: ${err.id}`)),
							AgentError: (err: AgentError) =>
								Effect.fail(new Error(err.message)),
						}),
						Effect.catchAll((err: unknown) =>
							Effect.fail(err instanceof Error ? err : new Error(String(err))),
						),
					),
				);
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					details: result as object,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					isError: true,
					content: [{ type: "text", text: message }],
					details: { error: message } as object,
				};
			}
		},

		renderCall: renderAgentCall,
		renderResult: renderAgentResult,
	};
}
