import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Effect, Stream, Ref, Cause } from "effect";
import { StringEnum } from "@mariozechner/pi-ai";
import type { Model, Api } from "@mariozechner/pi-ai";
import type { AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import {
	AgentControl,
	AgentLimitReached,
	AgentDepthExceeded,
	AgentNotFound,
	AgentError,
	type ControlSpawnOptions,
	type WaitResult,
} from "./services.js";
import { AgentRegistry } from "./agent-registry.js";
import type { AgentId } from "./types.js";
import { renderAgentCall, renderAgentResult } from "./render.js";
import type { ApprovalBroker } from "./approval-broker.js";

/**
 * Convert an AbortSignal to an Effect that completes when the signal aborts.
 * Uses Effect.async with the provided AbortSignal for cleanup.
 */
function abortSignalEffect(signal: AbortSignal | undefined): Effect.Effect<void> {
	if (!signal) {
		return Effect.never; // Never completes if no signal
	}
	
	// If already aborted, complete immediately
	if (signal.aborted) {
		return Effect.void;
	}
	
	return Effect.async<void>((resume) => {
		const onAbort = () => resume(Effect.void);
		signal.addEventListener("abort", onAbort, { once: true });
		// Cleanup is handled by the AbortSignal passed to async
	});
}

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
			description: "Agent IDs to wait for. If omitted, waits for ALL active agents. Returns when all finish (completed/failed/shutdown)" 
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

type ToolResult = {
	isError?: boolean;
	content: Array<{ type: "text"; text: string }>;
	details: object;
};

/**
 * Execute wait action with streaming updates via onUpdate callback.
 * If no ids provided, waits for all active agents.
 * Handles abort signals for interruption.
 */
async function executeWaitWithUpdates(
	runEffect: <A, E>(effect: Effect.Effect<A, E, AgentControl>) => Promise<A>,
	p: Static<typeof AgentParams>,
	onUpdate: AgentToolUpdateCallback<object> | undefined,
	signal: AbortSignal | undefined,
): Promise<ToolResult> {
	try {
		// Ref to store the latest result for interruption handling
		const latestResultRef = await runEffect(Ref.make<WaitResult | null>(null));

		const program = Effect.gen(function* () {
			const control = yield* AgentControl;
			
			// If no ids provided, get all active agent ids
			let ids = p.ids as AgentId[] | undefined;
			if (!ids || ids.length === 0) {
				const agents = yield* control.list;
				ids = agents.map(a => a.id);
			}
			
			// If still no agents, return informative result immediately
			if (ids.length === 0) {
				const result: WaitResult = { 
					status: {}, 
					timedOut: false,
					agentTypes: {},
				};
				yield* Ref.set(latestResultRef, result);
				return result;
			}
			
			const stream = control.waitStream(ids, p.timeout_ms, 1000);
			
			// Create abort effect that completes when signal triggers
			const abortEffect = abortSignalEffect(signal);
			
			// Run the stream with interruption handling
			const streamRun = stream
				.pipe(
					Stream.tap((result) =>
						Effect.gen(function* () {
							yield* Ref.set(latestResultRef, result);
							if (onUpdate) {
								onUpdate({
									content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
									details: result,
								});
							}
						})
					),
					Stream.runDrain,
					// Interrupt when abort signal triggers
					Effect.race(abortEffect)
				);
			
			yield* streamRun;
			
			// Return final result from ref
			return yield* Ref.get(latestResultRef).pipe(
				Effect.map((r) => r ?? { status: {}, timedOut: false })
			);
		});

		const result = await runEffect(
			program.pipe(
				Effect.catchAllCause((cause) =>
					Effect.gen(function* () {
						// Check if this was an interruption (from abort signal)
						if (Cause.isInterrupted(cause)) {
							const lastResult = yield* Ref.get(latestResultRef);
							if (lastResult) {
								return { ...lastResult, interrupted: true };
							}
						}
						// Re-throw real errors
						return yield* Effect.failCause(cause);
					})
				),
				Effect.catchAll((err: unknown) =>
					Effect.fail(err instanceof Error ? err : new Error(String(err))),
				),
			),
		);

		return {
			content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			details: result,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			isError: true,
			content: [{ type: "text", text: message }],
			details: { error: message },
		};
	}
}

export interface AgentToolDef {
	name: string;
	label: string;
	description: string;
	parameters: TSchema;
	execute: (
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: unknown,
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

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const context = getContext();
			const p = params as Static<typeof AgentParams>;
			
			// Special case for wait: use streaming with onUpdate and abort handling
			if (p.action === "wait") {
				const typedOnUpdate = onUpdate as AgentToolUpdateCallback<object> | undefined;
				return executeWaitWithUpdates(runEffect, p, typedOnUpdate, signal);
			}
			
			const program: Effect.Effect<object, AgentLimitReached | AgentDepthExceeded | AgentNotFound | AgentError | Error, AgentControl> = Effect.gen(function* () {
				const control = yield* AgentControl;

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
								Effect.fail(new Error(`Agent limit reached (max: ${err.max}). Close completed agents (agent close <id>) or wait for running agents to finish.`)),
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
