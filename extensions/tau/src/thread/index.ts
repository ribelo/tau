import { Type } from "@sinclair/typebox";
import { Effect, Option } from "effect";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { findThreads, readThread } from "./service.js";
import {
  renderFindThreadCall,
  renderFindThreadResult,
  renderReadThreadCall,
  renderReadThreadResult,
} from "./renderer.js";
import type { FindThreadResult, ReadThreadResult } from "./types.js";
import { ThreadAmbiguousError, ThreadNotFoundError } from "./errors.js";

// =============================================================================
// TypeBox Parameters
// =============================================================================

const FindThreadParams = Type.Object({
  query: Type.String({
    description: "Search query to find threads by ID, title, or content.",
    minLength: 1,
    maxLength: 500,
  }),
});

const ReadThreadParams = Type.Object({
  threadID: Type.String({
    description: "The thread ID to read (exact ID or unique prefix).",
    minLength: 1,
  }),
  goal: Type.Optional(
    Type.String({
      description:
        "Optional goal to focus the transcript on relevant sections.",
      maxLength: 500,
    })
  ),
});

// =============================================================================
// Tool Definitions
// =============================================================================

export function createThreadToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "find_thread",
      label: "find_thread",
      description:
        "Search for threads/sessions by query. Finds threads by ID, title, or content. Searches current workspace first, then globally. Returns thread metadata including ID, title, message count, and timestamps.",
      promptSnippet: "Search for threads by query",
      parameters: FindThreadParams,

      renderCall(args, theme) {
        return new Text(renderFindThreadCall(args, theme), 0, 0);
      },

      renderResult(result, options, theme) {
        if (options.isPartial) {
          return new Text(theme.fg("warning", "Searching threads…"), 0, 0);
        }

        const details = (result as { details?: FindThreadResult }).details;
        if (!details) {
          return new Text(theme.fg("dim", "(no results)"), 0, 0);
        }

        return new Text(renderFindThreadResult(details, options.expanded, theme), 0, 0);
      },

      async execute(_toolCallId, params, _signal, onUpdate, _ctx) {
        onUpdate?.({
          content: [{ type: "text", text: "Searching threads…" }],
          details: {},
        });

        const typedParams = params as { query: string };
        const cwd = _ctx?.cwd ?? process.cwd();

        const program = findThreads(typedParams.query, cwd);
        const result = await Effect.runPromise(program);

        // Format text content for LLM
        const textContent = result.threads
          .map(
            (t, i) =>
              `[${i + 1}] ${t.title}\n` +
              `ID: ${t.id}\n` +
              `CWD: ${t.cwd}\n` +
              `Messages: ${t.messageCount} · Updated: ${t.updatedAt}\n` +
              `Preview: ${t.preview}`
          )
          .join("\n\n");

        return {
          content: [
            {
              type: "text" as const,
              text:
                textContent || "No threads found matching the query.",
            },
          ],
          details: result,
        };
      },
    },

    {
      name: "read_thread",
      label: "read_thread",
      description:
        "Read the full transcript of a thread by ID. Returns a formatted markdown transcript including user messages, assistant responses, and tool results. Use 'goal' to focus on specific content. Respects branch context and compaction summaries.",
      promptSnippet: "Read a thread transcript by ID",
      parameters: ReadThreadParams,

      renderCall(args, theme) {
        return new Text(renderReadThreadCall(args, theme), 0, 0);
      },

      renderResult(result, options, theme) {
        if (options.isPartial) {
          return new Text(theme.fg("warning", "Reading thread…"), 0, 0);
        }

        const details = (result as { details?: ReadThreadResult }).details;
        if (!details) {
          return new Text(theme.fg("dim", "(no content)"), 0, 0);
        }

        return new Text(
          renderReadThreadResult(details, options.expanded, theme),
          0,
          0
        );
      },

      async execute(_toolCallId, params, _signal, onUpdate, _ctx) {
        onUpdate?.({
          content: [{ type: "text", text: "Reading thread…" }],
          details: {},
        });

        const typedParams = params as { threadID: string; goal?: string };
        const goal = typedParams.goal
          ? Option.some(typedParams.goal)
          : Option.none();
        const cwd = _ctx?.cwd ?? process.cwd();

        const program = readThread(
          typedParams.threadID,
          goal,
          cwd
        ).pipe(
          Effect.catch((error) => {
            if (error instanceof ThreadNotFoundError) {
              return Effect.succeed({
                ok: true as const,
                threadID: typedParams.threadID,
                resolvedPath: "",
                title: "Not Found",
                cwd,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                parentThreadId: undefined,
                totalMessages: 0,
                includedMessages: 0,
                truncated: false,
                content: `Thread "${typedParams.threadID}" not found.`,
              });
            }
            if (error instanceof ThreadAmbiguousError) {
              return Effect.succeed({
                ok: true as const,
                threadID: typedParams.threadID,
                resolvedPath: "",
                title: "Ambiguous Match",
                cwd,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                parentThreadId: undefined,
                totalMessages: 0,
                includedMessages: 0,
                truncated: false,
                content:
                  `Thread ID "${typedParams.threadID}" is ambiguous. ` +
                  `Multiple sessions match:\n` +
                  error.matches.map((m) => `  - ${m.id} (${m.path})`).join("\n"),
              });
            }
            throw error;
          })
        );

        const result = await Effect.runPromise(program) as ReadThreadResult;

        return {
          content: [
            {
              type: "text" as const,
              text: result.content,
            },
          ],
          details: result,
        };
      },
    },
  ];
}

export default function initThreadTools(pi: ExtensionAPI): void {
  for (const tool of createThreadToolDefinitions()) {
    pi.registerTool(tool);
  }
}
