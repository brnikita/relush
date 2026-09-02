/**
 * Event schema and JSONL sink (SPEC §4.9).
 *
 * Extends upstream `@earendil-works/pi-telemetry` rather than replacing it —
 * our addition is the per-step token/cost/latency record the router and
 * `/cost` depend on.
 */

export type { LayerTotals, Totals } from "./aggregate.ts";
export {
  aggregate,
  ESCALATION_SHARE_LIMIT,
  forSession,
  isStep,
  since,
  weekAgo,
  withinEscalationLimit,
} from "./aggregate.ts";
export type {
  CompactionEvent,
  Layer,
  LayerSwitchEvent,
  LocalDegradedEvent,
  RetrievalMissEvent,
  StepEvent,
  TelemetryEvent,
  TelemetryEventType,
  TokenUsage,
  VerificationResult,
} from "./events.ts";
export { cacheHitRate, inputTokens, LAYERS, totalTokens } from "./events.ts";
export type { ReadResult, SinkOptions, TelemetryMode } from "./sink.ts";
export { JsonlSink, parseMode, readEvents } from "./sink.ts";
export type { TimingSummary, TurnTiming } from "./timing.ts";
export { TurnTimer } from "./timing.ts";
export type { Validated, ValidationFailure, ValidationSuccess } from "./validate.ts";
export { validateEvent } from "./validate.ts";

export const PACKAGE = "telemetry" as const;
