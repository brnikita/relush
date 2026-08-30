/**
 * History manager (SPEC §4.4): observation masking, reversible compression,
 * overflow summarization and prefix pinning.
 *
 * Masking is the default and summarization the exception — LLM summaries hide
 * failure signals and lengthen trajectories (SPEC §1.1).
 */
export type { CacheOptions, ContentId } from "./cache.ts";
export { ContentCache, hashContent } from "./cache.ts";

export type { MaskingOptions } from "./masking.ts";
export {
  DEFAULT_KEEP_RECENT_TURNS,
  DEFAULT_MIN_TOKENS_TO_MASK,
  ExpandError,
  expand,
  isMasked,
  maskOldOutputs,
  maskPlaceholder,
  parseMaskPlaceholder,
} from "./masking.ts";

export const PACKAGE = "history" as const;
