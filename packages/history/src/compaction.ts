import type { ContentCache, ContentId } from "./cache.ts";

/**
 * Cache-first history compaction (SPEC §4.4).
 *
 * ## Why this is not v1.0's masking
 *
 * Providers cache on an exact prefix match, at a uniform 0.2× rate across the
 * OpenRouter catalogue. Rewriting a message therefore costs `0.8 × S` extra,
 * where `S` is everything after it. Break-even for compacting an output of `T`
 * tokens, with `R` subsequent requests before the next invalidation:
 *
 *     (T - PLACEHOLDER) × 0.2 × R  ≥  S × 0.8
 *
 * v1.0 used a sliding window that re-masked on every turn, pinning `R` at 1 and
 * making the real threshold `T ≥ 4S`. It shipped a threshold of 50 tokens and
 * measured 14.9% *more* expensive than not masking at all.
 *
 * Two properties fix that, and both are load-bearing:
 *
 * 1. **Batched.** Compaction fires only above a context-pressure threshold, and
 *    compacts a contiguous prefix in one operation. `R` rises from 1 to the
 *    number of turns before the next trigger.
 * 2. **Frozen.** Once compacted, a region is never recomputed. Its bytes are
 *    memoized and replayed verbatim, so the cache re-warms after one miss
 *    instead of missing forever. A "batched" compactor that recomputed its
 *    output each turn would be exactly as bad as v1.0.
 *
 * ## Two modes, because the honest arithmetic demands it
 *
 * Even batched, the break-even is severe: at `R = 20` with a 20,000-token
 * suffix, an output must exceed ~4,000 tokens to pay for the cache it costs.
 * Measured tool outputs on the `longhorizon` suite average ~160 tokens. So
 * **compaction as a cost optimization essentially never pays off**, and
 * pretending otherwise is how v1.0 shipped a regression.
 *
 * It is still necessary, for a different reason. The context window is finite,
 * and near the limit the alternative to compacting is not "spend a bit more" —
 * it is a failed request. Hence:
 *
 * - `opportunistic` (above `pressureThreshold`): compact only what clears
 *   break-even. Usually nothing, and that is the correct answer.
 * - `mandatory` (above `hardLimit`): compact largest-first until back under the
 *   limit, break-even notwithstanding, because feasibility outranks cost.
 */

/** Cached tokens cost this fraction of fresh ones. Uniform on OpenRouter. */
export const CACHE_RATE_RATIO = 0.2;

/** Approximate cost of a placeholder, in tokens. */
export const PLACEHOLDER_TOKENS = 25;

/** Fraction of the model window above which compaction is allowed to fire. */
export const DEFAULT_PRESSURE_THRESHOLD = 0.6;

/**
 * Fraction of the window above which compaction becomes mandatory.
 *
 * Past this point the alternative to compacting is a request that does not fit,
 * so cost stops being the deciding question.
 */
export const DEFAULT_HARD_LIMIT = 0.85;

/**
 * Turns a batch is assumed to survive before the next compaction.
 *
 * Deliberately conservative. Underestimating makes the threshold stricter and
 * merely forgoes a saving; overestimating compacts outputs that never pay for
 * themselves, which is the failure v1.0 shipped.
 */
export const DEFAULT_EXPECTED_REQUESTS = 20;

/**
 * Minimum output size worth compacting, from the break-even above.
 *
 * `suffixTokens` is everything after the candidate: the cache that a rewrite
 * throws away.
 */
export function breakEvenTokens(suffixTokens: number, expectedRequests: number): number {
  if (expectedRequests <= 0) return Number.POSITIVE_INFINITY;
  return (
    (suffixTokens * (1 - CACHE_RATE_RATIO)) / (CACHE_RATE_RATIO * expectedRequests) +
    PLACEHOLDER_TOKENS
  );
}

interface TextPart {
  type: string;
  text?: string;
}

export interface MessageLike {
  role: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export const compactedPlaceholder = (tokens: number, id: ContentId): string =>
  `[output compacted: ${tokens.toLocaleString("en-US")} tokens, sha=${id}. Call expand("${id}") to retrieve it.]`;

export const parseCompactedPlaceholder = (text: string): ContentId | undefined =>
  /^\[output compacted: [\d,]+ tokens, sha=([0-9a-f]+)\./.exec(text)?.[1];

export const isCompacted = (text: string): boolean => parseCompactedPlaceholder(text) !== undefined;

const textOf = (content: unknown): string | undefined => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;

  const parts = content as TextPart[];
  // A text placeholder cannot represent an image, and the transcript could not
  // describe what was lost.
  if (parts.some((p) => p.type !== "text")) return undefined;
  return parts.map((p) => p.text ?? "").join("");
};

/**
 * Patterns marking output that must survive verbatim (SPEC §4.4 rule 5).
 *
 * Hiding a failure signal is what makes LLM summarization lengthen
 * trajectories: the model stops seeing that a test failed and repeats the
 * attempt. Preserving them is the reason masking was chosen over summarizing,
 * so compacting them away would discard the rationale for the whole design.
 */
const FAILURE_SIGNALS = [
  /\b(?:assertion|assert)\s*(?:error|failed)/i,
  /\bTraceback \(most recent call last\)/,
  /\b(?:Error|Exception|Panic):/,
  /^\s*at\s+\S+\s+\(.*:\d+:\d+\)/m,
  /\b\d+\s+(?:test|spec)s?\s+failed/i,
  /\bFAIL(?:ED)?\b/,
  /\bnpm ERR!/,
  /\bexit(?:ed with)? (?:code|status) [1-9]/i,
] as const;

export const carriesFailureSignal = (text: string): boolean =>
  FAILURE_SIGNALS.some((pattern) => pattern.test(text));

export interface CompactionOptions {
  readonly cache: ContentCache;
  readonly countTokens: (text: string) => number;
  /** Model context window, in tokens. */
  readonly windowTokens: number;
  readonly pressureThreshold?: number;
  readonly hardLimit?: number;
  readonly expectedRequests?: number;
  /** Turns at the end that are never compacted, however large. */
  readonly keepRecentTurns?: number;
  readonly onCompact?: (event: {
    id: ContentId;
    tokensBefore: number;
    tokensAfter: number;
  }) => void;
}

export type CompactionMode = "append-only" | "opportunistic" | "mandatory";

export interface CompactionDecision {
  /** Whether this call rewrote anything. */
  readonly compacted: boolean;
  readonly mode: CompactionMode;
  readonly reason: string;
  readonly messages: readonly MessageLike[];
}

/** Turns are delimited by assistant messages. */
const isTurnBoundary = (message: MessageLike): boolean => message.role === "assistant";

/**
 * Stateful, batched compactor. One instance per session.
 *
 * Holds the frozen prefix so repeated turns replay identical bytes.
 */
export class BatchedCompactor {
  private readonly options: CompactionOptions;
  /** Messages `[0, frozenThrough)` have been compacted and must not change. */
  private frozenThrough = 0;
  /** Replacements for the frozen region, by index. Replayed verbatim. */
  private readonly frozen = new Map<number, MessageLike>();
  private compactionCount = 0;

  constructor(options: CompactionOptions) {
    this.options = options;
  }

  /** Number of batched compactions performed. */
  get batches(): number {
    return this.compactionCount;
  }

  private totalTokens(messages: readonly MessageLike[]): number {
    return messages.reduce((sum, m) => sum + this.options.countTokens(textOf(m.content) ?? ""), 0);
  }

  /** Replays already-frozen replacements over the transcript. */
  private applyFrozen(messages: readonly MessageLike[]): MessageLike[] {
    if (this.frozen.size === 0) return [...messages];
    return messages.map((message, index) => this.frozen.get(index) ?? message);
  }

  /**
   * Returns the transcript to send, compacting only under pressure.
   *
   * The ordinary path is append-only: the input is returned with previously
   * frozen replacements applied and nothing else touched.
   */
  process(messages: readonly MessageLike[]): CompactionDecision {
    const withFrozen = this.applyFrozen(messages);

    const pressure = this.options.pressureThreshold ?? DEFAULT_PRESSURE_THRESHOLD;
    const hard = this.options.hardLimit ?? DEFAULT_HARD_LIMIT;
    const used = this.totalTokens(withFrozen);
    const pressureLimit = this.options.windowTokens * pressure;
    const hardLimit = this.options.windowTokens * hard;

    if (used < pressureLimit) {
      return {
        compacted: false,
        mode: "append-only",
        reason: `below pressure threshold (${used} < ${Math.round(pressureLimit)} tokens)`,
        messages: withFrozen,
      };
    }

    // Past the hard limit the alternative is a request that does not fit, so
    // break-even stops being the deciding question.
    const mandatory = used >= hardLimit;
    return this.compactBatch(withFrozen, mandatory, hardLimit);
  }

  /**
   * Compacts a contiguous prefix in one operation.
   *
   * Walks candidates oldest-first and stops at the recent window. Each
   * candidate is judged against the break-even for the suffix it would
   * invalidate — which shrinks as the scan advances, so later candidates face a
   * lower bar, not a higher one.
   */
  private compactBatch(
    messages: readonly MessageLike[],
    mandatory: boolean,
    hardLimit: number,
  ): CompactionDecision {
    const keep = this.options.keepRecentTurns ?? 6;
    const expected = this.options.expectedRequests ?? DEFAULT_EXPECTED_REQUESTS;

    // First index inside the protected recent window.
    let boundary = messages.length;
    let turns = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message && isTurnBoundary(message)) {
        turns += 1;
        if (turns > keep) break;
      }
      boundary = i;
    }

    const sizes = messages.map((m) => this.options.countTokens(textOf(m.content) ?? ""));
    const total = sizes.reduce((a, b) => a + b, 0);

    /** Candidates, with the suffix each would invalidate. */
    const candidates: { index: number; tokens: number; suffix: number }[] = [];
    let suffix = total;

    for (let i = 0; i < boundary; i++) {
      const message = messages[i];
      suffix -= sizes[i] ?? 0;

      if (!message || message.role !== "toolResult") continue;
      if (this.frozen.has(i)) continue;

      const text = textOf(message.content);
      if (text === undefined || isCompacted(text)) continue;

      // Rule 5: failure signals survive verbatim, whatever the mode. This is
      // the reason masking was chosen over summarizing; discarding it under
      // pressure would discard the rationale.
      if (message.isError === true || carriesFailureSignal(text)) continue;

      candidates.push({ index: i, tokens: sizes[i] ?? 0, suffix });
    }

    // Under duress, spend the single cache invalidation on the biggest wins.
    if (mandatory) candidates.sort((a, b) => b.tokens - a.tokens);

    const result = [...messages];
    let freed = 0;
    let remaining = total;
    let compactedAny = false;

    for (const candidate of candidates) {
      // Opportunistic mode compacts only what pays for the cache it costs.
      if (!mandatory && candidate.tokens < breakEvenTokens(candidate.suffix, expected)) continue;
      // Mandatory mode stops as soon as the transcript fits again; every extra
      // rewrite past that point is pure loss.
      if (mandatory && remaining <= hardLimit) break;

      const message = messages[candidate.index];
      if (!message) continue;
      const text = textOf(message.content);
      if (text === undefined) continue;

      const id = this.options.cache.put(text);
      const placeholder = compactedPlaceholder(candidate.tokens, id);
      const tokensAfter = this.options.countTokens(placeholder);
      if (tokensAfter >= candidate.tokens) continue;

      const replacement: MessageLike = {
        ...message,
        content: [{ type: "text", text: placeholder }],
      };

      result[candidate.index] = replacement;
      // Freeze it: later turns replay these exact bytes rather than recomputing,
      // so the cache re-warms after one miss.
      this.frozen.set(candidate.index, replacement);
      this.frozenThrough = Math.max(this.frozenThrough, candidate.index + 1);

      freed += candidate.tokens - tokensAfter;
      remaining -= candidate.tokens - tokensAfter;
      compactedAny = true;

      this.options.onCompact?.({ id, tokensBefore: candidate.tokens, tokensAfter });
    }

    if (compactedAny) this.compactionCount += 1;

    const mode: CompactionMode = mandatory ? "mandatory" : "opportunistic";
    return {
      compacted: compactedAny,
      mode,
      reason: compactedAny
        ? `${mode} batch ${this.compactionCount}: freed ${freed} tokens`
        : mandatory
          ? "over hard limit but nothing compactable remains"
          : "under pressure but no candidate cleared break-even",
      messages: result,
    };
  }
}

export class ExpandError extends Error {
  constructor(id: string) {
    super(`no cached content for id ${id}`);
    this.name = "ExpandError";
  }
}

/** Retrieves compacted content by id. */
export function expand(cache: ContentCache, id: ContentId): string {
  const content = cache.getText(id);
  if (content === undefined) throw new ExpandError(id);
  return content;
}
