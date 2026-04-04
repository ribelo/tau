import { Effect, Option } from "effect";
import type { FindThreadResult, ReadThreadResult } from "./types.js";
import {
  searchLocalSessions,
  searchGlobalSessions,
  resolveThreadPath,
} from "./search.js";
import { readThreadContent } from "./read.js";
import { ThreadCatalogError, ThreadNotFoundError } from "./errors.js";

const MAX_RESULTS = 10;

/**
 * Find threads matching a query
 */
export function findThreads(
  query: string,
  cwd: string
): Effect.Effect<FindThreadResult, ThreadCatalogError> {
  return Effect.gen(function* () {
    // First search local sessions
    let threads = yield* searchLocalSessions(query, cwd);

    // If no local results, search globally
    if (threads.length === 0) {
      threads = yield* searchGlobalSessions(query, cwd);
    }

    return {
      ok: true as const,
      query,
      threads,
      hasMore: threads.length >= MAX_RESULTS,
    };
  });
}

/**
 * Read a thread by ID
 */
export function readThread(
  threadID: string,
  goal: Option.Option<string>,
  cwd: string
): Effect.Effect<ReadThreadResult, ThreadCatalogError | ThreadNotFoundError> {
  return Effect.gen(function* () {
    const resolved = yield* resolveThreadPath(threadID, cwd);

    if (Option.isNone(resolved)) {
      return yield* new ThreadNotFoundError({ threadID });
    }

    const { path, entry } = resolved.value;

    const result = yield* readThreadContent(
      path,
      goal,
      entry.name || entry.firstUserMessage.slice(0, 60) || "Untitled",
      entry.cwd,
      entry.createdAt,
      entry.updatedAt,
      entry.parentSession,
      entry.messageCount
    );

    return result;
  });
}
