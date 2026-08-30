/**
 * Event schema and JSONL sink (SPEC §4.9).
 *
 * Extends upstream `@earendil-works/pi-telemetry` rather than replacing it —
 * our addition is the per-step token/cost/latency record the router and
 * `/cost` depend on.
 */
export const PACKAGE = "telemetry" as const;
