import { countTextTokens } from "@nodrel/ai";
import type { CompactionEvent } from "@nodrel/telemetry";
import { ContentCache } from "./cache.ts";
import { BatchedCompactor, type CompactionMode, type MessageLike } from "./compaction.ts";

/**
 * Packages the history manager as an extension for `@nodrel/core` (SPEC §4.4).
 *
 * The stage is stateful, holding one `BatchedCompactor` per session. That is
 * the point: a stateless stage would recompute its output on every turn and
 * invalidate the provider cache each time, which is exactly the regression
 * DEVIATION-002 recorded.
 */

interface HistoryStageLike {
  readonly name: string;
  transform(messages: unknown[], signal?: AbortSignal): Promise<unknown[]>;
}

export interface HistoryExtensionOptions {
  /** Cache root; conventionally `<repo>/.agent/cache`. */
  readonly cacheRoot: string;
  /** Model context window, in tokens. Compaction is relative to this. */
  readonly windowTokens: number;
  readonly pressureThreshold?: number;
  readonly hardLimit?: number;
  readonly keepRecentTurns?: number;
  readonly sessionId?: string;
  readonly onCompaction?: (event: CompactionEvent) => void;
  /** Reports each decision, including the decision to do nothing. */
  readonly onDecision?: (decision: { mode: CompactionMode; reason: string }) => void;
}

export interface HistoryExtension {
  readonly name: string;
  readonly historyStages: readonly HistoryStageLike[];
  readonly cache: ContentCache;
}

/**
 * Builds the history extension.
 *
 * Token counting uses the same estimator as `check:budgets`, so placeholder
 * sizes and budget numbers agree. Two counters would make any reported saving
 * unverifiable.
 */
export function createHistoryExtension(options: HistoryExtensionOptions): HistoryExtension {
  const cache = new ContentCache({ root: options.cacheRoot });
  const sessionId = options.sessionId ?? "unknown";

  const compactor = new BatchedCompactor({
    cache,
    countTokens: countTextTokens,
    windowTokens: options.windowTokens,
    ...(options.pressureThreshold === undefined
      ? {}
      : { pressureThreshold: options.pressureThreshold }),
    ...(options.hardLimit === undefined ? {} : { hardLimit: options.hardLimit }),
    ...(options.keepRecentTurns === undefined ? {} : { keepRecentTurns: options.keepRecentTurns }),
    onCompact: ({ id, tokensBefore, tokensAfter }) =>
      options.onCompaction?.({
        type: "compaction",
        ts: new Date().toISOString(),
        sessionId,
        kind: "compress",
        tokensBefore,
        tokensAfter,
        sha: id,
      }),
  });

  const stage: HistoryStageLike = {
    name: "batched-compaction",
    transform: async (messages) => {
      const decision = compactor.process(messages as MessageLike[]);
      options.onDecision?.({ mode: decision.mode, reason: decision.reason });
      return decision.messages as unknown[];
    },
  };

  return { name: "history", historyStages: [stage], cache };
}
