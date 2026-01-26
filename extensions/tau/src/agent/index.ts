import { Type, type Static } from "@sinclair/typebox";
import { Effect, Layer, Cause } from "effect";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	AgentControl,
	AgentConfig,
	type ControlSpawnOptions,
} from "./services.js";
import { AgentControlLive } from "./control.js";
import { AgentManagerLive } from "./manager.js";
import { PiAPILive } from "../effect/pi.js";
import { TaskRegistry } from "./registry.js";
import type { AgentId } from "./types.js";
import { renderAgentCall, renderAgentResult } from "./render.js";
import { createUiApprovalBroker } from "./approval-broker.js";
import { SandboxLive } from "../services/sandbox.js";
import { SandboxStateLive } from "../services/state.js";
import { PersistenceLive } from "../services/persistence.js";
import { PiLoggerLive } from "../effect/logger.js";

const AgentParams = Type.Object({
	action: StringEnum(["spawn", "send", "wait", "close", "list"] as const, {
		description: "Action to perform",
	}),
	// spawn
	type: Type.Optional(Type.String({ description: "Task type for spawn" })),
	message: Type.Optional(
		Type.String({ description: "Message to send (spawn/send)" }),
	),
	complexity: Type.Optional(
		StringEnum(["low", "medium", "high"] as const, {
			description: "Complexity for spawn (default: medium)",
		}),
	),
	skills: Type.Optional(
		Type.Array(Type.String(), {
			description: "Extra skills to inject (only for spawn)",
		}),
	),
	result_schema: Type.Optional(
		Type.Any({
			description:
				"JSON schema for structured output (spawn). Agent must call submit_result.",
		}),
	),
	// send/close
	id: Type.Optional(Type.String({ description: "Agent ID for send/close" })),
	interrupt: Type.Optional(
		Type.Boolean({
			description: "Interrupt current work before sending (send)",
		}),
	),
	// wait
	ids: Type.Optional(
		Type.Array(Type.String(), { description: "Agent IDs to wait for" }),
	),
	timeout_ms: Type.Optional(
		Type.Number({ description: "Timeout in ms for wait (max 300000)" }),
	),
});

function buildToolDescription(): string {
	const registry = TaskRegistry.builtins();
	const lines: string[] = [];
	lines.push(
		"Manage non-blocking agent tasks. Actions: spawn, send, wait, close, list.\n",
	);
	lines.push("## Task types");
	for (const t of registry) {
		lines.push(`- ${t.name}: ${t.description || ""}`.trim());
	}
	return lines.join("\n").trim();
}

export default function initAgent(pi: ExtensionAPI) {
	const AgentConfigLive = Layer.succeed(AgentConfig, AgentConfig.of({
		maxThreads: 4,
		maxDepth: 3,
	}));

	const MainLayer = AgentControlLive.pipe(
		Layer.provide(AgentManagerLive),
		Layer.provide(AgentConfigLive),
		Layer.provide(SandboxLive),
		Layer.provide(SandboxStateLive),
		Layer.provide(PersistenceLive),
		Layer.provide(PiLoggerLive),
		Layer.provide(PiAPILive(pi)),
	);

	pi.registerTool({
		name: "agent",
		label: "agent",
		description: buildToolDescription(),
		parameters: AgentParams,

		async execute(_toolCallId, params, _onUpdate, ctx, _signal) {
			const approvalBroker =
				ctx.hasUI && ctx.ui && typeof ctx.ui.confirm === "function"
					? createUiApprovalBroker(ctx.ui)
					: undefined;

			const program = Effect.gen(function* () {
				const control = yield* AgentControl;
				const p = params as Static<typeof AgentParams>;

				switch (p.action) {
					case "spawn": {
						if (!p.type || !p.message) {
							return yield* Effect.fail(
								new Error("spawn requires 'type' and 'message'"),
							);
						}
						const id = yield* control.spawn({
							type: p.type,
							message: p.message,
							complexity: p.complexity,
							skills: p.skills,
							result_schema: p.result_schema,
							approvalBroker,
							parentSessionId: ctx.sessionManager.getSessionId(),
							cwd: ctx.cwd,
						} satisfies ControlSpawnOptions as ControlSpawnOptions);
						return { agent_id: id };
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

			const resultOrCause = await Effect.runPromiseExit(
				program.pipe(
					Effect.catchAll((err) => {
						const message = err instanceof Error ? err.message : String(err);
						return Effect.fail(message);
					}),
					Effect.provide(MainLayer),
				),
			);

			if (resultOrCause._tag === "Failure") {
				return {
					isError: true,
					content: [{ type: "text", text: Cause.pretty(resultOrCause.cause) }],
					details: { error: resultOrCause.cause },
				};
			}

			const result = resultOrCause.value;

			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: result as object,
			};
		},

		renderCall(args, theme) {
			return renderAgentCall(args, theme);
		},
		renderResult(result, options, theme) {
			return renderAgentResult(result, options, theme);
		},
	});
}
