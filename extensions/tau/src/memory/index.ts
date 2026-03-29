import { Effect } from "effect";
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

import { CuratedMemory, type MutationResult } from "../services/curated-memory.js";
import { type MemoryBucketSnapshot, type MemoryEntry, type MemoryScope } from "./format.js";
import { MemoryDuplicateEntry, MemoryEmptyContent, MemoryEntryTooLarge, MemoryFileError, MemoryNoMatch } from "./errors.js";
import {
	renderMemoriesMessage,
	renderMemoryCall,
	renderMemoryResult,
	type MemoriesMessageDetails,
	type MemoryToolAction,
	type MemoryToolDetails,
} from "./renderer.js";

const StringEnum = <T extends string[]>(values: [...T]) => Type.Unsafe<T[number]>({ type: "string", enum: values });

const MemoryToolParams = Type.Object({
	action: StringEnum(["add", "update", "remove"]),
	target: StringEnum(["project", "global", "user"]),
	content: Type.Optional(Type.String({ description: "Entry content. Required for add and update." })),
	id: Type.Optional(Type.String({ description: "Exact memory entry id. Required for update and remove." })),
});
type MemoryToolParams = Static<typeof MemoryToolParams>;

const TOOL_DESCRIPTION = "Save durable information to persistent memory that survives across sessions. Memory is injected into future sessions, so keep it compact and focused on facts that will still matter later.\n\nWHEN TO SAVE (do this proactively, do not wait to be asked):\n- User corrects you or says 'remember this' / 'don't do that again'\n- User shares a preference, habit, or personal detail (name, role, timezone, coding style)\n- You discover something about the environment (OS, installed tools, project structure)\n- You learn a convention, API quirk, or workflow specific to this user's setup\n\nPRIORITY: User preferences and corrections > environment facts > procedural knowledge. The most valuable memory prevents the user from having to repeat themselves.\n\nDo NOT save task progress, session outcomes, completed-work logs, or temporary TODO state.\n\nTHREE TARGETS:\n- 'project': workspace-specific facts. Stored at the nearest workspace root in .pi/tau/memories/PROJECT.jsonl\n- 'global': notes that apply across projects. Stored in ~/.pi/agent/tau/memories/MEMORY.jsonl\n- 'user': who the user is - name, role, preferences, communication style, pet peeves. Stored in ~/.pi/agent/tau/memories/USER.jsonl\n\nACTIONS: add (new entry), update (replace an existing entry by id), remove (delete an existing entry by id). No read action - memory is already in the system prompt.\n\nEvery successful action returns the affected memory entry. Per-entry limits are enforced per scope: project/global 1000 chars, user 500 chars.\n\nSKIP: trivial/obvious info, things easily re-discovered, raw data dumps, temporary TODO state.";

type ToolDetails = MemoryToolDetails;

type ToolResult = { content: { type: "text"; text: string }[]; details: ToolDetails };

const MEMORIES_MESSAGE_TYPE = "memories";

function toolOk(text: string, details: Omit<ToolDetails, "success"> = {}): ToolResult {
	return { content: [{ type: "text", text }], details: { success: true, ...details } };
}

function toolFail(text: string, details: Omit<ToolDetails, "success"> = {}): ToolResult {
	return { content: [{ type: "text", text }], details: { success: false, ...details } };
}

function formatEntry(entry: MemoryEntry): string {
	return [`id: ${entry.id}`, `chars: ${entry.content.length}`, `content:\n${entry.content}`].join("\n");
}

function formatResult(result: MutationResult, message: string): string {
	return `${message}\n\n${formatEntry(result.entry)}`;
}

type SuccessfulMutation = {
	readonly text: string;
	readonly entry: MemoryEntry;
	readonly bucket: MemoryBucketSnapshot;
};

function attachBucket(
	memory: CuratedMemory["Service"],
	result: MutationResult,
	message: string,
	cwd: string,
): Effect.Effect<SuccessfulMutation, MemoryFileError> {
	return memory.getSnapshot(cwd).pipe(
		Effect.map((snapshot) => ({
			text: formatResult(result, message),
			entry: result.entry,
			bucket: snapshot[result.changedScope],
		})),
	);
}

export default function initMemory(
	pi: ExtensionAPI,
	runEffect: <A, E>(effect: Effect.Effect<A, E, CuratedMemory>) => Promise<A>,
): void {
	pi.on("context", async (event) => {
		const filtered = event.messages.filter(
			(message) => !(message?.role === "custom" && message?.customType === MEMORIES_MESSAGE_TYPE),
		);
		return { messages: filtered };
	});

	pi.registerCommand("memories", {
		description: "Show saved memories across project, global, and user scopes",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				return;
			}

			if ((args || "").trim()) {
				ctx.ui.notify("Usage: /memories", "info");
				return;
			}

			try {
				const snapshot = await runEffect(
					Effect.gen(function* () {
						const memory = yield* CuratedMemory;
						return yield* memory.getEntriesSnapshot(ctx.cwd);
					}),
				);

				pi.sendMessage(
					{
						customType: MEMORIES_MESSAGE_TYPE,
						content: "",
						display: true,
						details: { snapshot } satisfies MemoriesMessageDetails,
					},
					{ triggerTurn: false },
				);
			} catch (error: unknown) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerMessageRenderer<MemoriesMessageDetails>(MEMORIES_MESSAGE_TYPE, (message, _options, theme) => {
		const details = message.details;
		if (!details) {
			return new Text(theme.fg("dim", "(no memory details)"), 0, 0);
		}
		return renderMemoriesMessage(details, theme);
	});

	pi.registerTool({
		name: "memory",
		label: "memory",
		description: TOOL_DESCRIPTION,
		parameters: MemoryToolParams,
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			const params = rawParams as MemoryToolParams;
			const target = params.target as MemoryScope;
			const content = params.content?.trim();
			const id = params.id?.trim();
			const action = params.action as MemoryToolAction;

			const program = Effect.gen(function* () {
				const memory = yield* CuratedMemory;
				switch (params.action) {
					case "add": {
						if (!content) return "Content is required for 'add' action.";
						const result = yield* memory.add(target, content, ctx.cwd);
						return yield* attachBucket(memory, result, `Added entry to ${target} memory.`, ctx.cwd);
					}
					case "update": {
						if (!id) return "id is required for 'update' action.";
						if (!content) return "content is required for 'update' action.";
						const result = yield* memory.update(target, id, content, ctx.cwd);
						return yield* attachBucket(memory, result, `Updated ${target} memory.`, ctx.cwd);
					}
					case "remove": {
						if (!id) return "id is required for 'remove' action.";
						const result = yield* memory.remove(target, id, ctx.cwd);
						return yield* attachBucket(memory, result, `Removed entry from ${target} memory.`, ctx.cwd);
					}
				}
			});

			try {
				const result = await runEffect(program);
				if (typeof result === "string") {
					return toolFail(result, { action, scope: target });
				}
				return toolOk(result.text, {
					action,
					scope: target,
					entry: result.entry,
					bucket: result.bucket,
				});
			} catch (cause: unknown) {
				if (cause instanceof MemoryEntryTooLarge) {
					return toolFail(
						`Entry is ${cause.entryChars} chars, but ${cause.scope} memory allows at most ${cause.limitChars} chars per entry.`,
						{ action, scope: cause.scope },
					);
				}
				if (cause instanceof MemoryNoMatch) {
					return toolFail(`No entry matched id '${cause.id}'.`, { action, scope: target });
				}
				if (cause instanceof MemoryDuplicateEntry) {
					let bucket: MemoryBucketSnapshot | undefined;
					try {
						bucket = await runEffect(CuratedMemory.use((memory) => memory.getSnapshot(ctx.cwd).pipe(Effect.map((snapshot) => snapshot[target]))));
					} catch {
						bucket = undefined;
					}
					return toolOk(`Entry already exists in ${target} memory.\n\n${formatEntry(cause.entry)}`, {
						action,
						scope: target,
						entry: cause.entry,
						...(bucket ? { bucket } : {}),
					});
				}
				if (cause instanceof MemoryEmptyContent) {
					return toolFail("Content cannot be empty.", { action, scope: target });
				}
				if (cause instanceof MemoryFileError) {
					return toolFail(`Memory file error: ${cause.reason}`, { action, scope: target });
				}
				return toolFail(cause instanceof Error ? cause.message : String(cause), {
					action,
					scope: target,
				});
			}
		},
		renderCall(args, theme) {
			return renderMemoryCall(args as Record<string, unknown> | undefined, theme);
		},
		renderResult(result, _options, theme) {
			return renderMemoryResult(result, theme);
		},
	});
}
