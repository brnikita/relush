import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StepEvent, TelemetryEvent } from "./events.ts";
import { cacheHitRate, inputTokens, totalTokens } from "./events.ts";
import { JsonlSink, parseMode, readEvents } from "./sink.ts";
import { validateEvent } from "./validate.ts";

const step = (overrides: Partial<StepEvent> = {}): StepEvent => ({
  type: "step",
  ts: "2026-08-30T12:00:00.000Z",
  sessionId: "s1",
  stepId: "step-1",
  layer: "flash",
  model: "z-ai/glm-5.3-flash",
  provider: "openrouter",
  tokens: { input: 100, cached: 900, output: 50 },
  costUsd: 0.000_1,
  latencyMs: 420,
  ...overrides,
});

const tempFile = (): string => join(mkdtempSync(join(tmpdir(), "nodrel-tel-")), "events.jsonl");

describe("token accounting", () => {
  it("counts cached tokens as input, not as a separate bucket", () => {
    const usage = { input: 100, cached: 900, output: 50 };

    expect(inputTokens(usage)).toBe(1000);
    expect(totalTokens(usage)).toBe(1050);
  });

  it("reports cache hit rate over input only, ignoring output", () => {
    // The §6 KPI is ">=75% of input tokens"; folding output in would understate it.
    expect(cacheHitRate({ input: 100, cached: 900, output: 10_000 })).toBeCloseTo(0.9);
  });

  it("returns 0 rather than NaN when a step has no input", () => {
    // Aggregates must stay summable without every caller guarding.
    expect(cacheHitRate({ input: 0, cached: 0, output: 5 })).toBe(0);
  });
});

describe("validateEvent", () => {
  it("accepts each event type in the schema", () => {
    const events: TelemetryEvent[] = [
      step(),
      {
        type: "retrieval_miss",
        ts: "2026-08-30T12:00:00.000Z",
        sessionId: "s1",
        queryId: "q1",
        path: "src/index.ts",
        wastedTokens: 1200,
      },
      {
        type: "compaction",
        ts: "2026-08-30T12:00:00.000Z",
        sessionId: "s1",
        kind: "mask",
        tokensBefore: 5000,
        tokensAfter: 40,
        sha: "abc123",
      },
      {
        type: "layer_switch",
        ts: "2026-08-30T12:00:00.000Z",
        sessionId: "s1",
        from: "flash",
        to: "escalation",
        reason: "two consecutive failed verifications",
      },
      {
        type: "local_degraded",
        ts: "2026-08-30T12:00:00.000Z",
        sessionId: "s1",
        reason: "ollama unreachable",
      },
    ];

    for (const event of events) {
      expect(validateEvent(event), `${event.type} should validate`).toMatchObject({ ok: true });
    }
  });

  it.each([
    ["unknown layer", step({ layer: "gpu" as never }), /layer must be one of/],
    ["negative tokens", step({ tokens: { input: -1, cached: 0, output: 0 } }), /non-negative/],
    ["negative cost", step({ costUsd: -0.5 }), /costUsd/],
    ["non-finite latency", step({ latencyMs: Number.NaN }), /latencyMs/],
    ["empty model", step({ model: "" }), /model/],
    ["bad timestamp", step({ ts: "not-a-date" }), /ISO-8601/],
  ])("rejects %s", (_label, event, pattern) => {
    const result = validateEvent(event);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(pattern);
  });

  it("rejects an unknown event type rather than passing it through", () => {
    const result = validateEvent({ type: "mystery", ts: "2026-08-30T12:00:00Z", sessionId: "s1" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown event type/);
  });

  it("omits absent optional fields instead of writing undefined", () => {
    const result = validateEvent(step());

    expect(result.ok).toBe(true);
    if (result.ok) expect("verification" in result.value).toBe(false);
  });
});

describe("JsonlSink", () => {
  it("round-trips events through disk", () => {
    const path = tempFile();
    const sink = new JsonlSink({ path });

    sink.record(step({ stepId: "a" }));
    sink.record(step({ stepId: "b", layer: "local", costUsd: 0 }));

    const { events, skipped } = readEvents(path);

    expect(skipped).toEqual([]);
    expect(events).toHaveLength(2);
    expect(events.map((e) => (e as StepEvent).stepId)).toEqual(["a", "b"]);
  });

  it("writes newline-delimited records, one per line", () => {
    const path = tempFile();
    const sink = new JsonlSink({ path });

    sink.record(step({ stepId: "a" }));
    sink.record(step({ stepId: "b" }));

    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("refuses to record an invalid event rather than corrupting the log", () => {
    const path = tempFile();
    const sink = new JsonlSink({ path });

    expect(() => sink.record(step({ costUsd: -1 }))).toThrow(/invalid telemetry event/);
    expect(readEvents(path).events).toEqual([]);
  });

  it("writes nothing when NODREL_TELEMETRY=off", () => {
    let writes = 0;
    const sink = new JsonlSink({
      path: "unused",
      mode: "off",
      write: () => {
        writes += 1;
      },
    });

    sink.record(step());

    expect(writes).toBe(0);
  });

  it("records local-layer steps even though they are cost-exempt", () => {
    // SPEC 4.5 exempts local tokens from budget caps, but the 6 local-share
    // KPI still needs the count, so they must be written.
    const path = tempFile();
    new JsonlSink({ path }).record(step({ layer: "local", costUsd: 0 }));

    expect(readEvents(path).events).toHaveLength(1);
  });
});

describe("readEvents", () => {
  it("survives a torn final line from a crash mid-write", () => {
    const path = tempFile();
    const sink = new JsonlSink({ path });
    sink.record(step({ stepId: "complete" }));

    // Simulate kill -9 during the next append.
    const partial = JSON.stringify(step({ stepId: "torn" })).slice(0, 40);
    writeFileSync(path, readFileSync(path, "utf8") + partial, "utf8");

    const { events, skipped } = readEvents(path);

    expect(events).toHaveLength(1);
    expect((events[0] as StepEvent).stepId).toBe("complete");
    expect(skipped).toEqual([{ line: 2, reason: "malformed JSON" }]);
  });

  it("reports a structurally invalid record without discarding valid ones", () => {
    const path = tempFile();
    new JsonlSink({ path }).record(step({ stepId: "good" }));
    writeFileSync(
      path,
      `${readFileSync(path, "utf8") + JSON.stringify({ type: "step", ts: "2026-08-30T12:00:00Z", sessionId: "s1" })}\n`,
      "utf8",
    );

    const { events, skipped } = readEvents(path);

    expect(events).toHaveLength(1);
    expect(skipped[0]?.reason).toMatch(/stepId/);
  });

  it("returns empty for a file that does not exist yet", () => {
    expect(readEvents(join(tmpdir(), "nodrel-absent", "nope.jsonl"))).toEqual({
      events: [],
      skipped: [],
    });
  });
});

describe("parseMode", () => {
  it.each([
    ["off", "off"],
    ["aggregate", "aggregate"],
    ["local", "local"],
    [undefined, "local"],
    ["nonsense", "local"],
  ])("maps %s to %s", (input, expected) => {
    expect(parseMode(input)).toBe(expected);
  });
});
