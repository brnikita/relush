import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Layer, StepEvent } from "@nodrel/telemetry";
import { JsonlSink } from "@nodrel/telemetry";
import { describe, expect, it } from "vitest";
import { costReport } from "./cost.ts";

const NOW = new Date("2026-08-30T12:00:00.000Z");

const step = (layer: Layer, overrides: Partial<StepEvent> = {}): StepEvent => ({
  type: "step",
  ts: "2026-08-30T11:00:00.000Z",
  sessionId: "s1",
  stepId: `s-${Math.random()}`,
  layer,
  model: "z-ai/glm-5.3-flash",
  provider: "openrouter",
  tokens: { input: 1000, cached: 0, output: 100 },
  costUsd: 0.001,
  latencyMs: 500,
  ...overrides,
});

const withEvents = (events: StepEvent[]): string => {
  const path = join(mkdtempSync(join(tmpdir(), "nodrel-cost-")), "events.jsonl");
  const sink = new JsonlSink({ path });
  for (const event of events) sink.record(event);
  return path;
};

describe("costReport", () => {
  it("reconciles reported totals against the telemetry log", () => {
    // F9's gate: the printed total must equal the sum of recorded steps.
    const events = [
      step("flash", { costUsd: 0.0012 }),
      step("flash", { costUsd: 0.0008 }),
      step("local", { costUsd: 0 }),
    ];
    const report = costReport({ telemetryPath: withEvents(events), now: NOW });

    // 0.0012 + 0.0008 + 0 = 0.0020
    expect(report).toContain("$0.0020");
    expect(report).toMatch(/total\s+3 steps/);
  });

  it("breaks the session down by layer", () => {
    const report = costReport({
      telemetryPath: withEvents([step("flash"), step("local"), step("escalation")]),
      now: NOW,
    });

    expect(report).toMatch(/flash/);
    expect(report).toMatch(/local/);
    expect(report).toMatch(/escalate/);
  });

  it("flags an escalation share above the SPEC §4.5 limit", () => {
    const report = costReport({
      telemetryPath: withEvents([
        step("flash", { tokens: { input: 100, cached: 0, output: 0 } }),
        step("escalation", { tokens: { input: 900, cached: 0, output: 0 } }),
      ]),
      now: NOW,
    });

    expect(report).toMatch(/OVER the 15\.0% limit/);
  });

  it("does not flag an escalation share within the limit", () => {
    const report = costReport({
      telemetryPath: withEvents([
        step("flash", { tokens: { input: 950, cached: 0, output: 0 } }),
        step("escalation", { tokens: { input: 50, cached: 0, output: 0 } }),
      ]),
      now: NOW,
    });

    expect(report).not.toMatch(/OVER/);
  });

  it("reports cache hit rate over input tokens", () => {
    const report = costReport({
      telemetryPath: withEvents([
        step("flash", { tokens: { input: 100, cached: 900, output: 0 } }),
      ]),
      now: NOW,
    });

    expect(report).toMatch(/cache hit\s+90\.0%/);
  });

  it("scopes the session view to one session while the week spans all", () => {
    const path = withEvents([step("flash"), step("flash", { sessionId: "other" })]);

    const report = costReport({ telemetryPath: path, sessionId: "s1", now: NOW });

    expect(report).toMatch(/Session[\s\S]*?total\s+1 steps/);
    expect(report).toMatch(/Last 7 days[\s\S]*?total\s+2 steps/);
  });

  it("excludes steps older than the rolling week", () => {
    const path = withEvents([
      step("flash", { ts: "2026-08-29T12:00:00.000Z" }),
      step("flash", { ts: "2026-07-01T12:00:00.000Z" }),
    ]);

    const report = costReport({ telemetryPath: path, now: NOW });

    expect(report).toMatch(/Last 7 days[\s\S]*?total\s+1 steps/);
  });

  it("says so plainly when nothing has been recorded", () => {
    const path = join(mkdtempSync(join(tmpdir(), "nodrel-cost-")), "absent.jsonl");

    expect(costReport({ telemetryPath: path, now: NOW })).toContain("no steps recorded");
  });

  it("surfaces unreadable records rather than quietly undercounting", () => {
    const path = withEvents([step("flash")]);
    writeFileSync(path, `${JSON.stringify(step("flash")).slice(0, 30)}`, { flag: "a" });

    // A shrinking total must never be mistaken for cheaper operation.
    expect(costReport({ telemetryPath: path, now: NOW })).toMatch(/1 unreadable record/);
  });

  it("shows free local steps at zero cost", () => {
    const report = costReport({
      telemetryPath: withEvents([step("local", { costUsd: 0 })]),
      now: NOW,
    });

    expect(report).toMatch(/local\s+1 steps[\s\S]*?\$0/);
  });
});
