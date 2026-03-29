import { Effect } from "effect";
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { CuratedMemory, type MutationResult } from "../services/curated-memory.js";
import { renderMemorySnapshotXml, type MemoryScope, type MemorySnapshot } from "./format.js";
import { MemoryAmbiguousMatch, MemoryDuplicateEntry, MemoryEmptyContent, MemoryFileError, MemoryLimitExceeded, MemoryNoMatch } from "./errors.js";

const StringEnum = <T extends string[]>(values: [...T]) => Type.Unsafe<T[number]>({ type: "string", enum: values });

const MemoryToolParams = Type.Object({
	action: StringEnum(["add", "update", "remove"]),
	target: StringEnum(["project", "global", "user"]),
	content: Type.Optional(Type.String({ description: "Entry content. Required for add and update." })),
	old_text: Type.Optional(Type.String({ description: "Short unique substring identifying the entry to update or remove." })),
});
type MemoryToolParams = Static<typeof MemoryToolParams>;

const TOOL_DESCRIPTION = "Save durable information to persistent memory that survives across sessions. Memory is injected into future sessions, so keep it compact and focused on facts that will still matter later.\n\nWHEN TO SAVE (do this proactively, do not wait to be asked):\n- User corrects you or says 'remember this' / 'don't do that again'\n- User shares a preference, habit, or personal detail (name, role, timezone, coding style)\n- You discover something about the environment (OS, installed tools, project structure)\n- You learn a convention, API quirk, or workflow specific to this user's setup\n\nPRIORITY: User preferences and corrections > environment facts > procedural knowledge. The most valuable memory prevents the user from having to repeat themselves.\n\nDo NOT save task progress, session outcomes, completed-work logs, or temporary TODO state.\n\nTHREE TARGETS:\n- 'project': workspace-specific facts. Stored at the nearest workspace root in .pi/tau/memories/PROJECT.md\n- 'global': notes that apply across projects. Stored in ~/.pi/agent/tau/memories/MEMORY.md\n- 'user': who the user is - name, role, preferences, communication style, pet peeves. Stored in ~/.pi/agent/tau/memories/USER.md\n\nACTIONS: add (new entry), update (change an existing entry identified by old_text), remove (delete an existing entry identified by old_text). No read action - memory is already in the system prompt.\n\nEvery successful action returns the full current memory snapshot as XML, including the backing file path for each scope.\n\nSKIP: trivial/obvious info, things easily re-discovered, raw data dumps, temporary task state.";

type ToolDetails = {
	readonly success: boolean;
	readonly scope?: MemoryScope;
	readonly snapshot?: MemorySnapshot;
};

type ToolResult = { content: { type: "text"; text: string }[]; details: ToolDetails };

function toolOk(text: string, details: Omit<ToolDetails, "success"> = {}): ToolResult {
	return { content: [{ type: "text", text }], details: { success: true, ...details } };
}

function toolFail(text: string, details: Omit<ToolDetails, "success"> = {}): ToolResult {
	return { content: [{ type: "text", text }], details: { success: false, ...details } };
}

function formatResult(result: MutationResult, message: string): string {
	return `${message}\n\n${result.rendered}`;
}

function formatSnapshot(snapshot: MemorySnapshot, message: string): string {
	return `${message}\n\n${renderMemorySnapshotXml(snapshot, { includeEmpty: true })}`;
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
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			const params = rawParams as MemoryToolParams;
			const target = params.target as MemoryScope;
			const content = params.content?.trim();
			const oldText = params.old_text?.trim();

			const program = Effect.gen(function* () {
				const memory = yield* CuratedMemory;
				switch (params.action) {
					case "add": {
						if (!content) return "Content is required for 'add' action.";
						const result = yield* memory.add(target, content, ctx.cwd);
						return {
							text: formatResult(result, `Added entry to ${target} memory.`),
							snapshot: result.snapshot,
						};
					}
					case "update": {
						if (!oldText) return "old_text is required for 'update' action.";
						if (!content) return "content is required for 'update' action.";
						const result = yield* memory.update(target, oldText, content, ctx.cwd);
						return {
							text: formatResult(result, `Updated ${target} memory.`),
							snapshot: result.snapshot,
						};
					}
					case "remove": {
						if (!oldText) return "old_text is required for 'remove' action.";
						const result = yield* memory.remove(target, oldText, ctx.cwd);
						return {
							text: formatResult(result, `Removed entry from ${target} memory.`),
							snapshot: result.snapshot,
						};
					}
				}
			});

			try {
				const result = await runEffect(program);
				if (typeof result === "string") {
					return toolFail(result);
				}
				return toolOk(result.text, { scope: target, snapshot: result.snapshot });
			} catch (cause: unknown) {
				if (cause instanceof MemoryLimitExceeded) {
					return toolFail(`Memory at ${cause.currentChars}/${cause.limitChars} chars. Adding this entry (${cause.entryChars} chars) would exceed the limit. Replace or remove existing entries first.\n\nCurrent entries:\n${cause.currentEntries.join("\n§\n")}`);
				}
				if (cause instanceof MemoryAmbiguousMatch) return toolFail(`Multiple entries (${cause.matchCount}) matched. Be more specific.\nMatches:\n${cause.previews.join("\n")}`);
				if (cause instanceof MemoryNoMatch) return toolFail(`No entry matched '${cause.substring}'.`);
				if (cause instanceof MemoryDuplicateEntry) {
					const snapshot = await runEffect(
						Effect.gen(function* () {
							const memory = yield* CuratedMemory;
							return yield* memory.getSnapshot(ctx.cwd);
						}),
					);
					return toolOk(formatSnapshot(snapshot, `Entry already exists in ${target} memory.`), {
						scope: target,
						snapshot,
					});
				}
				if (cause instanceof MemoryEmptyContent) return toolFail("Content cannot be empty.");
				if (cause instanceof MemoryFileError) return toolFail(`Memory file error: ${cause.reason}`);
				return toolFail(cause instanceof Error ? cause.message : String(cause));
			}
		},
	});
}
