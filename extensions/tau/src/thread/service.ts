import { Effect, Option } from "effect";
import type { FindThreadResult, ReadThreadResult } from "./types.js";
import {
  searchLocalSessions,
  searchGlobalSessions,
  resolveThreadPath,
} from "./search.js";
import { readThreadContent } from "./read.js";
import {
  ThreadAmbiguousError,
  ThreadCatalogError,
  ThreadNotFoundError,
} from "./errors.js";

const MAX_RESULTS = 10;

/**
 * Find threads matching a query
 */
export function findThreads(
  query: string,
  cwd: string
): Effect.Effect<FindThreadResult, ThreadCatalogError> {
  return Effect.gen(function* () {
    // Search local and global sessions in parallel
    const [localThreads, globalThreads] = yield* Effect.all([
      searchLocalSessions(query, cwd),
      searchGlobalSessions(query, cwd),
    ]);

    // Deduplicate by ID, keeping local entries first
    const seen = new Set<string>(localThreads.map((t) => t.id));
    const merged = [
      ...localThreads,
      ...globalThreads.filter((t) => !seen.has(t.id)),
    ]
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULTS);

    return {
      ok: true as const,
      query,
      threads: merged,
      hasMore:
        localThreads.length >= MAX_RESULTS ||
        globalThreads.length >= MAX_RESULTS,
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
): Effect.Effect<
  ReadThreadResult,
  ThreadCatalogError | ThreadNotFoundError | ThreadAmbiguousError
> {
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
