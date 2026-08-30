import { countTextTokens } from "@nodrel/ai";
import type { CompactionEvent } from "@nodrel/telemetry";
import { ContentCache } from "./cache.ts";
import { DEFAULT_KEEP_RECENT_TURNS, maskOldOutputs } from "./masking.ts";

/**
 * Packages the history manager as an extension for `@nodrel/core` (SPEC §4.4).
 *
 * Stage order is the contract, not an implementation detail. Masking runs
 * before anything that inspects the prefix, so what gets pinned is the
 * already-masked transcript; reversing them would pin bytes that the next turn
 * rewrites, and the provider cache would miss on every request.
 */

/** Structural stand-in for the core `Extension` type, avoiding a cycle. */
interface HistoryStageLike {
  readonly name: string;
  transform(messages: unknown[], signal?: AbortSignal): Promise<unknown[]>;
}

export interface HistoryExtensionOptions {
  /** Cache root; conventionally `<repo>/.agent/cache`. */
  readonly cacheRoot: string;
  readonly keepRecentTurns?: number;
  readonly sessionId?: string;
  /** Receives a compaction event per masked output, for telemetry. */
  readonly onCompaction?: (event: CompactionEvent) => void;
}

export interface HistoryExtension {
  readonly name: string;
  readonly historyStages: readonly HistoryStageLike[];
  readonly cache: ContentCache;
}

/**
 * Builds the history extension.
 *
 * Token counting uses the same estimator as the budget check, so the sizes in
 * a mask placeholder and the numbers in `check:budgets` agree. Two different
 * counters would make masking's reported savings unverifiable.
 */
export function createHistoryExtension(options: HistoryExtensionOptions): HistoryExtension {
  const cache = new ContentCache({ root: options.cacheRoot });
  const sessionId = options.sessionId ?? "unknown";

  const masking: HistoryStageLike = {
    name: "observation-masking",
    transform: async (messages) =>
      maskOldOutputs(messages as never[], {
        cache,
        keepRecentTurns: options.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS,
        countTokens: countTextTokens,
        onMask: ({ id, tokensBefore, tokensAfter }) =>
          options.onCompaction?.({
            type: "compaction",
            ts: new Date().toISOString(),
            sessionId,
            kind: "mask",
            tokensBefore,
            tokensAfter,
            sha: id,
          }),
      }) as unknown[],
  };

  return {
    name: "history",
    historyStages: [masking],
    cache,
  };
}
