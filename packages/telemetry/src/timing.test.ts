import { describe, expect, it } from "vitest";
import { TurnTimer } from "./timing.ts";

const replay = (events: [string, number][]) => {
  const timer = new TurnTimer();
  for (const [type, at] of events) timer.record(type, at);
  return timer.summary();
};

describe("TurnTimer", () => {
  it("splits a turn into ttft, provider time and tool time", () => {
    const s = replay([
      ["turn_start", 0],
      ["message_start", 10],
      ["message_update", 400], // first token
      ["message_end", 1200],
      ["tool_execution_start", 1210],
      ["tool_execution_end", 1710],
      ["turn_end", 1720],
    ]);

    expect(s.perTurn[0]).toEqual({
      turn: 1,
      ttftMs: 400,
      providerMs: 1200,
      toolMs: 500,
      toolCalls: 1,
    });
  });

  it("attributes what is left to the harness", () => {
    // 1720 total, 1200 provider, 500 tool -> 20ms of our own overhead.
    const s = replay([
      ["turn_start", 0],
      ["message_update", 400],
      ["message_end", 1200],
      ["tool_execution_start", 1210],
      ["tool_execution_end", 1710],
      ["turn_end", 1720],
    ]);

    expect(s.harnessMs).toBe(20);
  });

  it("sums several tool calls within one turn", () => {
    const s = replay([
      ["turn_start", 0],
      ["message_end", 100],
      ["tool_execution_start", 100],
      ["tool_execution_end", 300],
      ["tool_execution_start", 300],
      ["tool_execution_end", 350],
      ["turn_end", 360],
    ]);

    expect(s.perTurn[0]?.toolMs).toBe(250);
    expect(s.perTurn[0]?.toolCalls).toBe(2);
  });

  it("uses message_end as ttft when no delta was seen", () => {
    // A non-streaming provider delivers the whole message at once.
    const s = replay([
      ["turn_start", 0],
      ["message_end", 900],
      ["turn_end", 910],
    ]);

    expect(s.perTurn[0]?.ttftMs).toBe(900);
  });

  it("averages across turns", () => {
    const s = replay([
      ["turn_start", 0],
      ["message_update", 100],
      ["message_end", 500],
      ["turn_end", 500],
      ["turn_start", 500],
      ["message_update", 800],
      ["message_end", 1500],
      ["turn_end", 1500],
    ]);

    expect(s.turns).toBe(2);
    expect(s.meanTtftMs).toBe(200);
    expect(s.meanProviderMs).toBe(750);
    expect(s.totalMs).toBe(1500);
  });

  it("ignores events it does not model", () => {
    expect(() =>
      replay([
        ["agent_start", 0],
        ["something_else", 5],
      ]),
    ).not.toThrow();
  });

  it("reports zeros rather than NaN with no turns", () => {
    const s = new TurnTimer().summary();
    expect(s).toMatchObject({ turns: 0, meanTtftMs: 0, meanProviderMs: 0, harnessMs: 0 });
  });
});
