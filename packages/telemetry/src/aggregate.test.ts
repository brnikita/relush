import { describe, expect, it } from "vitest";
import {
  aggregate,
  ESCALATION_SHARE_LIMIT,
  forSession,
  since,
  weekAgo,
  withinEscalationLimit,
} from "./aggregate.ts";
import type { Layer, StepEvent, TelemetryEvent } from "./events.ts";

const step = (layer: Layer, overrides: Partial<StepEvent> = {}): StepEvent => ({
  type: "step",
  ts: "2026-08-30T12:00:00.000Z",
  sessionId: "s1",
  stepId: `step-${Math.random()}`,
  layer,
  model: "m",
  provider: "openrouter",
  tokens: { input: 100, cached: 0, output: 100 },
  costUsd: 0.001,
  latencyMs: 100,
  ...overrides,
});

describe("aggregate", () => {
  it("sums tokens and cost across steps", () => {
    const totals = aggregate([step("flash"), step("flash")]);

    expect(totals.steps).toBe(2);
    expect(totals.tokens).toEqual({ input: 200, cached: 0, output: 200 });
    expect(totals.costUsd).toBeCloseTo(0.002, 6);
  });

  it("breaks totals down by layer", () => {
    const totals = aggregate([step("flash"), step("local"), step("local")]);

    expect(totals.byLayer.map((l) => [l.layer, l.steps])).toEqual([
      ["local", 2],
      ["flash", 1],
    ]);
  });

  it("omits layers with no activity, keeping /cost free of empty rows", () => {
    const totals = aggregate([step("flash")]);

    expect(totals.byLayer).toHaveLength(1);
  });

  it("computes escalation share over tokens, not step count", () => {
    // One expensive escalation step can dominate tokens while being a minority
    // of steps; the SPEC 4.5 invariant is about tokens.
    const totals = aggregate([
      step("flash", { tokens: { input: 10, cached: 0, output: 10 } }),
      step("escalation", { tokens: { input: 400, cached: 0, output: 380 } }),
    ]);

    expect(totals.escalationShare).toBeCloseTo(780 / 800, 3);
  });

  it("computes local share for the SPEC 6 KPI", () => {
    const totals = aggregate([
      step("local", { tokens: { input: 300, cached: 0, output: 0 } }),
      step("flash", { tokens: { input: 700, cached: 0, output: 0 } }),
    ]);

    expect(totals.localShare).toBeCloseTo(0.3, 6);
  });

  it("computes cache hit rate over input tokens only", () => {
    const totals = aggregate([
      step("flash", { tokens: { input: 100, cached: 900, output: 5000 } }),
    ]);

    // Output must not dilute the rate, or the >=75% KPI is unreachable.
    expect(totals.cacheHitRate).toBeCloseTo(0.9, 6);
  });

  it("averages latency per step", () => {
    const totals = aggregate([
      step("flash", { latencyMs: 100 }),
      step("flash", { latencyMs: 300 }),
    ]);

    expect(totals.meanLatencyMs).toBe(200);
  });

  it("ignores non-step events", () => {
    const events: TelemetryEvent[] = [
      step("flash"),
      {
        type: "compaction",
        ts: "2026-08-30T12:00:00.000Z",
        sessionId: "s1",
        kind: "mask",
        tokensBefore: 5000,
        tokensAfter: 40,
      },
    ];

    expect(aggregate(events).steps).toBe(1);
  });

  it("returns zeros rather than NaN for an empty log", () => {
    const totals = aggregate([]);

    expect(totals.steps).toBe(0);
    expect(totals.costUsd).toBe(0);
    expect(totals.escalationShare).toBe(0);
    expect(totals.cacheHitRate).toBe(0);
    expect(totals.meanLatencyMs).toBe(0);
  });
});

describe("escalation invariant", () => {
  it("accepts a run at exactly the 15% limit", () => {
    const totals = aggregate([
      step("flash", { tokens: { input: 850, cached: 0, output: 0 } }),
      step("escalation", { tokens: { input: 150, cached: 0, output: 0 } }),
    ]);

    expect(totals.escalationShare).toBeCloseTo(ESCALATION_SHARE_LIMIT, 6);
    expect(withinEscalationLimit(totals)).toBe(true);
  });

  it("rejects a run above the limit", () => {
    const totals = aggregate([
      step("flash", { tokens: { input: 800, cached: 0, output: 0 } }),
      step("escalation", { tokens: { input: 200, cached: 0, output: 0 } }),
    ]);

    expect(withinEscalationLimit(totals)).toBe(false);
  });
});

describe("filtering", () => {
  it("keeps only the requested session", () => {
    const events = [step("flash"), step("flash", { sessionId: "other" })];

    expect(forSession(events, "s1")).toHaveLength(1);
  });

  it("keeps only events inside the window", () => {
    const now = new Date("2026-08-30T12:00:00.000Z");
    const events = [
      step("flash", { ts: "2026-08-29T12:00:00.000Z" }),
      step("flash", { ts: "2026-08-01T12:00:00.000Z" }),
    ];

    expect(since(events, weekAgo(now))).toHaveLength(1);
  });

  it("puts the week boundary seven days back", () => {
    const now = new Date("2026-08-30T12:00:00.000Z");

    expect(weekAgo(now).toISOString()).toBe("2026-08-23T12:00:00.000Z");
  });
});
