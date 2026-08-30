import type { Layer, StepEvent, TelemetryEvent, TokenUsage } from "./events.ts";
import { LAYERS } from "./events.ts";

/**
 * Aggregation for `/cost` and for eval comparisons (SPEC §4.1, §4.9).
 *
 * The layer breakdown is the point, not a detail. A single blended figure hides
 * the two things that decide whether nodrel is working: what share of tokens
 * escalated (SPEC §4.5 caps it at 15%) and what share ran locally for free
 * (SPEC §6 targets ≥30%).
 */

export interface LayerTotals {
  readonly layer: Layer;
  readonly steps: number;
  readonly tokens: TokenUsage;
  readonly costUsd: number;
  readonly latencyMsTotal: number;
}

export interface Totals {
  readonly steps: number;
  readonly tokens: TokenUsage;
  readonly costUsd: number;
  readonly byLayer: readonly LayerTotals[];
  /** Share of all tokens that ran on the escalation layer, in `[0, 1]`. */
  readonly escalationShare: number;
  /** Share of all tokens that ran locally, in `[0, 1]`. */
  readonly localShare: number;
  /** Share of input tokens served from the provider cache, in `[0, 1]`. */
  readonly cacheHitRate: number;
  /** Mean latency per step, in milliseconds. */
  readonly meanLatencyMs: number;
}

const emptyUsage = (): TokenUsage => ({ input: 0, cached: 0, output: 0 });

const addUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input: a.input + b.input,
  cached: a.cached + b.cached,
  output: a.output + b.output,
});

const usageTotal = (u: TokenUsage): number => u.input + u.cached + u.output;

export const isStep = (event: TelemetryEvent): event is StepEvent => event.type === "step";

/** Aggregates step events into totals, overall and per layer. */
export function aggregate(events: readonly TelemetryEvent[]): Totals {
  const steps = events.filter(isStep);

  const perLayer = new Map<
    Layer,
    { steps: number; tokens: TokenUsage; cost: number; ms: number }
  >();
  for (const layer of LAYERS) {
    perLayer.set(layer, { steps: 0, tokens: emptyUsage(), cost: 0, ms: 0 });
  }

  let tokens = emptyUsage();
  let costUsd = 0;
  let latencyMsTotal = 0;

  for (const step of steps) {
    tokens = addUsage(tokens, step.tokens);
    costUsd += step.costUsd;
    latencyMsTotal += step.latencyMs;

    const bucket = perLayer.get(step.layer);
    if (bucket) {
      bucket.steps += 1;
      bucket.tokens = addUsage(bucket.tokens, step.tokens);
      bucket.cost += step.costUsd;
      bucket.ms += step.latencyMs;
    }
  }

  const total = usageTotal(tokens);
  const inputTotal = tokens.input + tokens.cached;

  // Layers with no activity are dropped: an empty row is noise in `/cost`.
  const byLayer: LayerTotals[] = [];
  for (const layer of LAYERS) {
    const bucket = perLayer.get(layer);
    if (!bucket || bucket.steps === 0) continue;
    byLayer.push({
      layer,
      steps: bucket.steps,
      tokens: bucket.tokens,
      costUsd: bucket.cost,
      latencyMsTotal: bucket.ms,
    });
  }

  const shareOf = (layer: Layer): number => {
    const bucket = perLayer.get(layer);
    return total === 0 || !bucket ? 0 : usageTotal(bucket.tokens) / total;
  };

  return {
    steps: steps.length,
    tokens,
    costUsd,
    byLayer,
    escalationShare: shareOf("escalation"),
    localShare: shareOf("local"),
    cacheHitRate: inputTotal === 0 ? 0 : tokens.cached / inputTotal,
    meanLatencyMs: steps.length === 0 ? 0 : latencyMsTotal / steps.length,
  };
}

/** Keeps events at or after `since`. Used for the rolling weekly window. */
export const since = (events: readonly TelemetryEvent[], from: Date): TelemetryEvent[] =>
  events.filter((e) => Date.parse(e.ts) >= from.getTime());

/** Keeps events belonging to one session. */
export const forSession = (
  events: readonly TelemetryEvent[],
  sessionId: string,
): TelemetryEvent[] => events.filter((e) => e.sessionId === sessionId);

/** Start of the rolling 7-day window ending now. */
export const weekAgo = (now: Date = new Date()): Date =>
  new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

/**
 * Whether escalation stayed within the hard invariant of SPEC §4.5 (≤15%).
 *
 * A CI-tested invariant rather than a target, so it gets a named predicate
 * instead of a magic number at each call site.
 */
export const ESCALATION_SHARE_LIMIT = 0.15;

export const withinEscalationLimit = (totals: Totals): boolean =>
  totals.escalationShare <= ESCALATION_SHARE_LIMIT;
