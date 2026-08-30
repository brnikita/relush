/**
 * History manager (SPEC §4.4): observation masking, reversible compression,
 * overflow summarization and prefix pinning.
 *
 * Masking is the default and summarization the exception — LLM summaries hide
 * failure signals and lengthen trajectories (SPEC §1.1).
 */
export type { CacheOptions, ContentId } from "./cache.ts";
export { ContentCache, hashContent } from "./cache.ts";

export const PACKAGE = "history" as const;
