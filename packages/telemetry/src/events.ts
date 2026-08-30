/**
 * Telemetry event schema (SPEC §4.9).
 *
 * Every claim nodrel makes about token economy is settled from this record, so
 * the schema is the measurement instrument, not a debugging aid. Two design
 * rules follow from that:
 *
 * 1. **Cached input tokens are counted separately from fresh input.** The
 *    provider cache-hit KPI (§6: ≥75% of input tokens) is unmeasurable if they
 *    are summed, and prefix pinning is unfalsifiable without it.
 * 2. **Local tokens carry `costUsd: 0` but are still recorded.** SPEC §4.5
 *    exempts them from budget caps, which is a routing rule — not a reason to
 *    omit them, since the local-share KPI (§6) needs the count.
 */

/** Model layers from SPEC §4.5. */
export type Layer = "local" | "flash" | "escalation" | "byok";

export const LAYERS: readonly Layer[] = ["local", "flash", "escalation", "byok"] as const;

/**
 * Token counts for one provider request.
 *
 * `cached` is the portion of input served from the provider's KV cache. It is a
 * subset of nothing — `input` counts fresh tokens only, so the billable total
 * is `input + cached` with `cached` priced differently.
 */
export interface TokenUsage {
  readonly input: number;
  readonly cached: number;
  readonly output: number;
}

/** Outcome of a verification run (tests) attributed to a step. */
export type VerificationResult = "pass" | "fail" | "none";

interface EventBase {
  /** ISO-8601, UTC. */
  readonly ts: string;
  readonly sessionId: string;
}

/**
 * One provider request and its cost. The core record; everything in `/cost`
 * and every eval comparison aggregates these.
 */
export interface StepEvent extends EventBase {
  readonly type: "step";
  readonly stepId: string;
  readonly layer: Layer;
  readonly model: string;
  readonly provider: string;
  readonly tokens: TokenUsage;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly verification?: VerificationResult;
}

/**
 * The model read a whole file that a preceding `graph_query` already covered
 * (SPEC §4.3). Each one is a retrieval failure worth tuning away.
 */
export interface RetrievalMissEvent extends EventBase {
  readonly type: "retrieval_miss";
  readonly queryId: string;
  readonly path: string;
  /** Tokens the miss cost beyond what the graph response had already spent. */
  readonly wastedTokens: number;
}

/** History was reduced: masking, compression, or summarization (SPEC §4.4). */
export interface CompactionEvent extends EventBase {
  readonly type: "compaction";
  readonly kind: "mask" | "compress" | "summarize";
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  /** Hash of the preserved original in `.agent/cache/`, for `expand`. */
  readonly sha?: string;
}

/** The router moved between layers, or a provider fallback fired (SPEC §4.5). */
export interface LayerSwitchEvent extends EventBase {
  readonly type: "layer_switch";
  readonly from: Layer;
  readonly to: Layer;
  readonly reason: string;
}

/** Local runtime was unavailable and the session fell back (SPEC §4.6). */
export interface LocalDegradedEvent extends EventBase {
  readonly type: "local_degraded";
  readonly reason: string;
}

export type TelemetryEvent =
  | StepEvent
  | RetrievalMissEvent
  | CompactionEvent
  | LayerSwitchEvent
  | LocalDegradedEvent;

export type TelemetryEventType = TelemetryEvent["type"];

/** Total tokens billed for a step, cached included. */
export const totalTokens = (u: TokenUsage): number => u.input + u.cached + u.output;

/** Input tokens billed for a step, fresh and cached. */
export const inputTokens = (u: TokenUsage): number => u.input + u.cached;

/**
 * Share of input tokens served from cache, in `[0, 1]`.
 *
 * Returns 0 rather than NaN for a step with no input, so aggregates stay
 * summable without every caller guarding.
 */
export const cacheHitRate = (u: TokenUsage): number => {
  const total = inputTokens(u);
  return total === 0 ? 0 : u.cached / total;
};
