// DreamSubagent -- forked agent that reads transcripts and returns a
// structured DreamConsolidationPlan.  Uses an independent pi AgentSession
// with read-only tools and the configured dream model/thinking pair.

import { Effect, Layer, Schema, ServiceMap } from "effect";

import {
	createAgentSession,
	readOnlyTools,
	SessionManager,
	SettingsManager,
	DefaultResourceLoader,
	type ModelRegistry,
	type AgentSession,
} from "@mariozechner/pi-coding-agent";
import type {
	AssistantMessage,
	ThinkingLevel,
} from "@mariozechner/pi-ai";

import type {
	DreamConsolidationPlan,
	DreamProgressEvent,
	DreamSubagentRequest,
} from "./domain.js";
import { DreamConsolidationPlan as DreamConsolidationPlanSchema } from "./domain.js";
import {
	DreamSubagentAborted,
	DreamSubagentInvalidPlan,
	DreamSubagentSpawnFailed,
	type DreamSubagentError,
} from "./errors.js";
import { buildConsolidationPrompt } from "./prompt.js";
import { resolveModelPattern } from "../agent/worker.js";
import type { MemoryBucketEntriesSnapshot, MemoryEntry, MemoryEntriesSnapshot } from "../memory/format.js";

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

/**
 * Runtime context the caller must supply.  The DreamRunner provides these
 * when calling `plan()`.
 */
export interface DreamSubagentContext {
	readonly modelRegistry: ModelRegistry;
}

export interface DreamSubagentApi {
	readonly plan: (
		request: DreamSubagentRequest,
		context: DreamSubagentContext,
		onEvent: (event: DreamProgressEvent) => Effect.Effect<void>,
	) => Effect.Effect<DreamConsolidationPlan, DreamSubagentError>;
}

export class DreamSubagent extends ServiceMap.Service<DreamSubagent, DreamSubagentApi>()(
	"DreamSubagent",
) {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBucketForPrompt(bucket: MemoryBucketEntriesSnapshot): string {
	const header = `### ${bucket.bucket} (${bucket.chars}/${bucket.limitChars} chars, ${bucket.usagePercent}% used)`;
	if (bucket.entries.length === 0) {
		return `${header}\n  (empty)`;
	}
	const lines = bucket.entries.map(
		(e: MemoryEntry) => `  [${e.id}] (scope=${e.scope}, type=${e.type}) ${e.content}`,
	);
	return `${header}\n${lines.join("\n")}`;
}

function formatMemorySnapshotForPrompt(snapshot: MemoryEntriesSnapshot): string {
	return [
		formatBucketForPrompt(snapshot.project),
		formatBucketForPrompt(snapshot.global),
		formatBucketForPrompt(snapshot.user),
	].join("\n\n");
}

/** Map DreamThinking to pi-ai ThinkingLevel.  "off" is invalid for dream,
 *  so we only map the four supported levels. */
function mapThinking(level: "low" | "medium" | "high" | "xhigh"): ThinkingLevel {
	return level;
}

/** Extract text from an AssistantMessage's content parts. */
function extractAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

/**
 * Strip markdown code fences that the LLM may have wrapped around JSON
 * despite being told not to.
 */
function stripCodeFences(text: string): string {
	let cleaned = text.trim();
	if (cleaned.startsWith("```")) {
		const firstNewline = cleaned.indexOf("\n");
		if (firstNewline !== -1) {
			cleaned = cleaned.slice(firstNewline + 1);
		}
		if (cleaned.endsWith("```")) {
			cleaned = cleaned.slice(0, -3);
		}
		cleaned = cleaned.trim();
	}
	return cleaned;
}

/** Type guard for assistant messages from the pi message array. */
function isAssistantMessage(msg: unknown): msg is AssistantMessage {
	return (
		typeof msg === "object" &&
		msg !== null &&
		"role" in msg &&
		(msg as { role: unknown }).role === "assistant" &&
		"content" in msg &&
		Array.isArray((msg as { content: unknown }).content)
	);
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

interface SessionResult {
	readonly ok: true;
	readonly text: string;
}

interface SessionFailure {
	readonly ok: false;
	readonly reason: string;
}

/**
 * Subscribe to the session and wait for the agent_end event.
 * Returns the last assistant text or a failure reason.
 */
function waitForSessionEnd(session: AgentSession): Promise<SessionResult | SessionFailure> {
	return new Promise<SessionResult | SessionFailure>((resolve) => {
		const unsubscribe = session.subscribe((event) => {
			if (event.type !== "agent_end") {
				return;
			}

			unsubscribe();

			const messages: unknown[] = "messages" in event ? (event.messages as unknown[]) : [];
			const lastAssistant = [...messages].reverse().find(isAssistantMessage);

			if (!lastAssistant) {
				resolve({ ok: false, reason: "No assistant response from dream subagent" });
				return;
			}

			if (lastAssistant.stopReason === "error") {
				const errorReason = lastAssistant.errorMessage ?? extractAssistantText(lastAssistant) ?? "Agent ended with error";
				resolve({ ok: false, reason: errorReason });
				return;
			}

			if (lastAssistant.stopReason === "aborted") {
				resolve({ ok: false, reason: "Dream subagent was aborted" });
				return;
			}

			const text = extractAssistantText(lastAssistant);
			if (text.length === 0) {
				resolve({ ok: false, reason: "Dream subagent returned empty response" });
				return;
			}

			resolve({ ok: true, text });
		});
	});
}

// ---------------------------------------------------------------------------
// Core implementation
// ---------------------------------------------------------------------------

const decodePlan = Schema.decodeUnknownSync(DreamConsolidationPlanSchema);

function planImpl(
	request: DreamSubagentRequest,
	context: DreamSubagentContext,
	onEvent: (event: DreamProgressEvent) => Effect.Effect<void>,
): Effect.Effect<DreamConsolidationPlan, DreamSubagentError> {
	return Effect.gen(function* () {
		// ── Resolve model ────────────────────────────────────────────
		const allModels = context.modelRegistry.getAll();
		const resolvedModel = resolveModelPattern(request.model.model, allModels);

		if (!resolvedModel) {
			return yield* new DreamSubagentSpawnFailed({
				reason: `Could not resolve dream model: "${request.model.model}". Available: ${allModels.map((m) => `${m.provider}/${m.id}`).join(", ")}`,
			});
		}

		// ── Build prompt ─────────────────────────────────────────────
		yield* onEvent({ _tag: "PhaseChanged", phase: "orient", message: "Building consolidation prompt" });

		const memoryText = formatMemorySnapshotForPrompt(request.memorySnapshot);
		const transcriptPaths = request.transcriptCandidates.map((tc) => tc.path);

		const systemPrompt = buildConsolidationPrompt({
			memorySnapshot: memoryText,
			transcriptPaths,
			nowIso: request.nowIso,
			mode: request.mode,
		});

		// ── Create agent session ─────────────────────────────────────
		yield* onEvent({ _tag: "PhaseChanged", phase: "gather", message: "Spawning dream subagent" });

		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: request.cwd,
			settingsManager,
			appendSystemPromptOverride: () => [systemPrompt],
		});

		yield* Effect.tryPromise({
			try: () => resourceLoader.reload(),
			catch: (error) =>
				new DreamSubagentSpawnFailed({
					reason: `Failed to reload resource loader: ${String(error)}`,
				}),
		});

		const sessionResult = yield* Effect.tryPromise({
			try: () =>
				createAgentSession({
					cwd: request.cwd,
					model: resolvedModel,
					thinkingLevel: mapThinking(request.model.thinking),
					tools: readOnlyTools,
					customTools: [],
					modelRegistry: context.modelRegistry,
					sessionManager: SessionManager.inMemory(request.cwd),
					settingsManager,
					resourceLoader,
				}),
			catch: (error) =>
				new DreamSubagentSpawnFailed({
					reason: `Failed to create dream agent session: ${String(error)}`,
				}),
		});

		const session = sessionResult.session;

		// ── Prompt and wait ──────────────────────────────────────────
		yield* onEvent({
			_tag: "PhaseChanged",
			phase: "consolidate",
			message: `Running consolidation with ${resolvedModel.provider}/${resolvedModel.id}`,
		});

		const endPromise = waitForSessionEnd(session);

		yield* Effect.tryPromise({
			try: () =>
				session.prompt(
					"Begin the 4-phase memory consolidation. Read the transcript files listed above, then return your consolidation plan as a single JSON object.",
					{ source: "extension" },
				),
			catch: (error) =>
				new DreamSubagentSpawnFailed({
					reason: `Failed to prompt dream subagent: ${String(error)}`,
				}),
		});

		const result = yield* Effect.tryPromise({
			try: () => endPromise,
			catch: (error) =>
				new DreamSubagentAborted(),
		});

		if (!result.ok) {
			return yield* new DreamSubagentSpawnFailed({ reason: result.reason });
		}

		// ── Parse output ─────────────────────────────────────────────
		yield* onEvent({ _tag: "PhaseChanged", phase: "prune", message: "Parsing consolidation plan" });

		const jsonText = stripCodeFences(result.text);

		let parsed: unknown;
		try {
			parsed = JSON.parse(jsonText);
		} catch (jsonError: unknown) {
			return yield* new DreamSubagentInvalidPlan({
				reason: `Subagent output is not valid JSON: ${String(jsonError)}. First 500 chars: ${jsonText.slice(0, 500)}`,
			});
		}

		const plan = yield* Effect.try({
			try: () => decodePlan(parsed),
			catch: (decodeError) =>
				new DreamSubagentInvalidPlan({
					reason: `Subagent output does not match DreamConsolidationPlan schema: ${String(decodeError)}`,
				}),
		});

		yield* onEvent({
			_tag: "OperationsPlanned",
			total: plan.operations.length,
		});

		return plan;
	});
}

// ---------------------------------------------------------------------------
// Exported for testing
// ---------------------------------------------------------------------------

export { formatMemorySnapshotForPrompt as _formatMemorySnapshotForPrompt };
export { stripCodeFences as _stripCodeFences };
export { isAssistantMessage as _isAssistantMessage };

// ---------------------------------------------------------------------------
// Live layer
// ---------------------------------------------------------------------------

export const DreamSubagentLive = Layer.succeed(
	DreamSubagent,
	DreamSubagent.of({
		plan: planImpl,
	}),
);
