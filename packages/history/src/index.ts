/**
 * History manager (SPEC §4.4): cache-first batched compaction and prefix
 * pinning.
 *
 * The transcript is append-only by default. Compaction fires only under context
 * pressure, in batches at stable boundaries, because rewriting history
 * invalidates the provider prefix cache (DEVIATION-002).
 */
export type { CacheOptions, ContentId } from "./cache.ts";
export { ContentCache, hashContent } from "./cache.ts";
export type {
  CompactionDecision,
  CompactionMode,
  CompactionOptions,
  MessageLike,
} from "./compaction.ts";
export {
  BatchedCompactor,
  breakEvenTokens,
  CACHE_RATE_RATIO,
  carriesFailureSignal,
  compactedPlaceholder,
  DEFAULT_EXPECTED_REQUESTS,
  DEFAULT_HARD_LIMIT,
  DEFAULT_PRESSURE_THRESHOLD,
  ExpandError,
  expand,
  isCompacted,
  PLACEHOLDER_TOKENS,
  parseCompactedPlaceholder,
} from "./compaction.ts";
export type { HistoryExtension, HistoryExtensionOptions } from "./extension.ts";
export { createHistoryExtension } from "./extension.ts";
export type { BuildPrefixOptions, PinnedPrefix } from "./prefix.ts";
export { buildPrefix, PrefixDriftError, PrefixGuard, serializeTools } from "./prefix.ts";

export const PACKAGE = "history" as const;
