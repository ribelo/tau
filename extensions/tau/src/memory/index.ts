import { Effect } from "effect";
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { CuratedMemory, type MutationResult } from "../services/curated-memory.js";
import { MemoryAmbiguousMatch, MemoryDuplicateEntry, MemoryEmptyContent, MemoryFileError, MemoryLimitExceeded, MemoryNoMatch } from "./errors.js";
import type { MemoryBucket } from "./format.js";

const StringEnum = <T extends string[]>(values: [...T]) => Type.Unsafe<T[number]>({ type: "string", enum: values });

const MemoryToolParams = Type.Object({
	action: StringEnum(["add", "replace", "remove"]),
	target: StringEnum(["memory", "user"]),
	content: Type.Optional(Type.String({ description: "Entry content. Required for add and replace." })),
	old_text: Type.Optional(Type.String({ description: "Short unique substring identifying the entry to replace or remove." })),
});
type MemoryToolParams = Static<typeof MemoryToolParams>;

const TOOL_DESCRIPTION = "Save durable information to persistent memory that survives across sessions. Memory is injected into every future turn, so keep it compact and focused on facts that will still matter later.\n\nWHEN TO SAVE (do this proactively, do not wait to be asked):\n- User corrects you or says 'remember this' / 'don't do that again'\n- User shares a preference, habit, or personal detail (name, role, timezone, coding style)\n- You discover something about the environment (OS, installed tools, project structure)\n- You learn a convention, API quirk, or workflow specific to this user's setup\n\nPRIORITY: User preferences and corrections > environment facts > procedural knowledge. The most valuable memory prevents the user from having to repeat themselves.\n\nDo NOT save task progress, session outcomes, completed-work logs, or temporary TODO state.\n\nTWO TARGETS:\n- 'user': who the user is - name, role, preferences, communication style, pet peeves\n- 'memory': your notes - environment facts, project conventions, tool quirks, lessons learned\n\nACTIONS: add (new entry), replace (update existing - old_text identifies it), remove (delete - old_text identifies it). No read action - memory is already in the system prompt.\n\nSKIP: trivial/obvious info, things easily re-discovered, raw data dumps, temporary task state.";

type ToolResult = { content: { type: "text"; text: string }[]; details: unknown };
function toolOk(text: string): ToolResult { return { content: [{ type: "text", text }], details: { success: true } }; }
function toolFail(text: string): ToolResult { return { content: [{ type: "text", text }], details: { success: false } }; }

function formatResult(result: MutationResult, message: string): string {
	return `${message} ${result.entryCount} entries, ${result.usagePercent}% — ${result.currentChars}/${result.limitChars} chars.`;
}

export default function initMemory(
	pi: ExtensionAPI,
	runEffect: <A, E>(effect: Effect.Effect<A, E, CuratedMemory>) => Promise<A>,
): void {
	pi.registerTool({
		name: "memory",
		label: "memory",
		description: TOOL_DESCRIPTION,
		parameters: MemoryToolParams,
		async execute(_toolCallId, rawParams, _signal, _onUpdate, _ctx) {
			const params = rawParams as MemoryToolParams;
			const target = params.target as MemoryBucket;
			const content = params.content?.trim();
			const oldText = params.old_text?.trim();

			const program = Effect.gen(function* () {
				const memory = yield* CuratedMemory;
				switch (params.action) {
					case "add": {
						if (!content) return "Content is required for 'add' action.";
						return formatResult(yield* memory.add(target, content), "Entry added.");
					}
					case "replace": {
						if (!oldText) return "old_text is required for 'replace' action.";
						if (!content) return "content is required for 'replace' action.";
						return formatResult(yield* memory.replace(target, oldText, content), "Entry replaced.");
					}
					case "remove": {
						if (!oldText) return "old_text is required for 'remove' action.";
						return formatResult(yield* memory.remove(target, oldText), "Entry removed.");
					}
				}
			});

			try {
				return toolOk(await runEffect(program));
			} catch (cause: unknown) {
				if (cause instanceof MemoryLimitExceeded) {
					return toolFail(`Memory at ${cause.currentChars}/${cause.limitChars} chars. Adding this entry (${cause.entryChars} chars) would exceed the limit. Replace or remove existing entries first.\n\nCurrent entries:\n${cause.currentEntries.join("\n§\n")}`);
				}
				if (cause instanceof MemoryAmbiguousMatch) return toolFail(`Multiple entries (${cause.matchCount}) matched. Be more specific.\nMatches:\n${cause.previews.join("\n")}`);
				if (cause instanceof MemoryNoMatch) return toolFail(`No entry matched '${cause.substring}'.`);
				if (cause instanceof MemoryDuplicateEntry) return toolOk("Entry already exists (no duplicate added).");
				if (cause instanceof MemoryEmptyContent) return toolFail("Content cannot be empty.");
				if (cause instanceof MemoryFileError) return toolFail(`Memory file error: ${cause.reason}`);
				return toolFail(cause instanceof Error ? cause.message : String(cause));
			}
		},
	});
}
