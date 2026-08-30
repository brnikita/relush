import { countTextTokens, estimateToolTokens, FLASH } from "@nodrel/ai";
import { CORE_TOOLS, PINNED_INSTRUCTIONS, SYSTEM_PROMPT } from "@nodrel/core";
import { breakEvenTokens, CACHE_RATE_RATIO } from "@nodrel/history";
import { ESCALATION_TOKEN_LIMIT, Router } from "@nodrel/router";
import { describe, expect, it } from "vitest";

/**
 * The cross-cutting invariants (SPEC §4.1, §4.4, §4.5).
 *
 * Each of these spans packages, so no single package's tests would catch a
 * breach. They are asserted here, in the suite CI runs on every commit,
 * because each one is the reason some part of the design exists — and each is
 * the kind of thing that erodes silently under a deadline.
 */

describe("fixed overhead (SPEC §4.1)", () => {
  it("stays under 2,000 tokens", () => {
    const overhead =
      countTextTokens(SYSTEM_PROMPT) +
      CORE_TOOLS.reduce((sum, tool) => sum + estimateToolTokens(tool), 0) +
      countTextTokens(PINNED_INSTRUCTIONS);

    expect(overhead, `fixed overhead is ${overhead} tokens`).toBeLessThanOrEqual(2000);
  });

  it("ships exactly five core tools", () => {
    // A sixth tool taxes every request of every session; everything else is a
    // lazily-loaded skill (SPEC §4.7).
    expect(CORE_TOOLS).toHaveLength(5);
  });
});

describe("escalation share (SPEC §4.5)", () => {
  it("treats 15% as the hard limit", () => {
    expect(ESCALATION_TOKEN_LIMIT).toBe(0.15);
  });

  it("flags a session that exceeds it", () => {
    const router = new Router();
    router.recordUsage("flash", { input: 800, cached: 0, output: 0 });
    router.recordUsage("escalation", { input: 200, cached: 0, output: 0 });

    expect(router.withinEscalationLimit).toBe(false);
  });

  it("keeps a routed session inside the limit on ordinary work", () => {
    // Twenty ordinary steps must not drift into escalation on their own.
    const router = new Router();
    for (let step = 0; step < 20; step++) {
      const decision = router.route({ prompt: "add a null check to parse()" });
      router.recordUsage(decision.layer, { input: 1000, cached: 0, output: 200 });
      router.recordResult(true);
    }

    expect(router.escalationShare).toBe(0);
    expect(router.withinEscalationLimit).toBe(true);
  });
});

describe("cache economics (SPEC §4.4)", () => {
  it("prices cached input at a fifth of fresh input", () => {
    // The constant the whole compaction design is derived from. If a provider
    // changes it, the break-even changes with it.
    expect(FLASH.cost.cacheRead / FLASH.cost.input).toBeCloseTo(CACHE_RATE_RATIO, 6);
  });

  it("makes per-turn rewriting uneconomic, as DEVIATION-002 found", () => {
    // R = 1 is the sliding-window case: the threshold is 4x the suffix, which
    // no realistic tool output reaches.
    expect(breakEvenTokens(10_000, 1)).toBeGreaterThan(40_000);
  });

  it("lowers the threshold proportionally when a batch is reused", () => {
    expect(breakEvenTokens(10_000, 20)).toBeLessThan(breakEvenTokens(10_000, 1) / 10);
  });
});
