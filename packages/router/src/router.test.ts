import { describe, expect, it } from "vitest";
import { classify, IMPACT_ESCALATION_THRESHOLD } from "./classifier.ts";
import { ESCALATION_TOKEN_LIMIT, Router } from "./router.ts";

const tokens = (n: number) => ({ input: n, cached: 0, output: 0 });

describe("classify", () => {
  it.each([
    ["rename the helper function", "trivial"],
    ["fix a typo in the readme", "trivial"],
    ["write a commit message for this change", "local"],
    ["summarize this module", "local"],
    ["add a null check to parse()", "standard"],
    ["why does this deadlock under load?", "complex"],
    ["redesign the storage layer", "complex"],
    ["migrate the API to v2", "complex"],
  ])("classifies %s as %s", (prompt, expected) => {
    expect(classify({ prompt }).taskClass).toBe(expected);
  });

  it("sends ordinary work to the flash layer", () => {
    expect(classify({ prompt: "add a null check" }).layer).toBe("flash");
  });

  it("uses the local layer for mechanical work when one is available", () => {
    expect(classify({ prompt: "rename foo to bar", localAvailable: true }).layer).toBe("local");
  });

  it("falls back to flash for mechanical work with no local model", () => {
    expect(classify({ prompt: "rename foo to bar", localAvailable: false }).layer).toBe("flash");
  });

  it("lets impact size outrank the wording", () => {
    // A "one-line change" that touches 30 files is a wide change, and the
    // graph's measurement is more trustworthy than the phrasing.
    const result = classify({
      prompt: "just a small tweak",
      impactedFiles: IMPACT_ESCALATION_THRESHOLD + 1,
    });

    expect(result.layer).toBe("escalation");
    expect(result.reason).toMatch(/impact spans/);
  });

  it("does not escalate on impact at the threshold", () => {
    expect(
      classify({ prompt: "small tweak", impactedFiles: IMPACT_ESCALATION_THRESHOLD }).layer,
    ).toBe("flash");
  });
});

describe("Router escalation", () => {
  it("stays on flash while steps pass", () => {
    const router = new Router();
    router.recordResult(true);

    expect(router.route({ prompt: "add a check" }).layer).toBe("flash");
  });

  it("escalates after two consecutive failures", () => {
    const router = new Router();
    router.recordResult(false);
    router.recordResult(false);

    const decision = router.route({ prompt: "add a check" });
    expect(decision.layer).toBe("escalation");
    expect(decision.reason).toMatch(/consecutive failed verifications/);
  });

  it("does not escalate on a single failure", () => {
    const router = new Router();
    router.recordResult(false);

    expect(router.route({ prompt: "add a check" }).layer).toBe("flash");
  });

  it("resets the failure streak on a pass", () => {
    const router = new Router();
    router.recordResult(false);
    router.recordResult(true);
    router.recordResult(false);

    expect(router.route({ prompt: "add a check" }).layer).toBe("flash");
  });

  it("needs two greens to de-escalate, not one", () => {
    // One pass after escalating usually means the strong model fixed it, not
    // that the cheap model can now cope.
    const router = new Router();
    router.recordResult(false);
    router.recordResult(false);
    router.recordResult(true);

    expect(router.route({ prompt: "add a check" }).layer).toBe("escalation");

    router.recordResult(true);
    expect(router.route({ prompt: "add a check" }).layer).toBe("flash");
  });

  it("reports a switch so the TUI can show it", () => {
    const switches: { from: string; to: string }[] = [];
    const router = new Router({ onSwitch: (e) => switches.push(e) });

    router.recordResult(false);
    router.recordResult(false);
    router.route({ prompt: "x" });

    expect(switches).toEqual([
      { from: "flash", to: "escalation", reason: expect.stringMatching(/consecutive/) },
    ]);
  });

  it("does not report a switch when the layer is unchanged", () => {
    const switches: unknown[] = [];
    const router = new Router({ onSwitch: (e) => switches.push(e) });

    router.route({ prompt: "add a check" });
    router.route({ prompt: "add another check" });

    expect(switches).toEqual([]);
  });
});

describe("Router pinning", () => {
  it("honours an explicit pin over classification", () => {
    const router = new Router();
    router.setPin("local");

    expect(router.route({ prompt: "redesign the whole system" }).layer).toBe("local");
  });

  it("honours a pin over an active escalation", () => {
    // /fast has to actually work while the router wants to escalate.
    const router = new Router();
    router.recordResult(false);
    router.recordResult(false);
    router.setPin("flash");

    expect(router.route({ prompt: "x" }).layer).toBe("flash");
  });

  it("returns control to the router on auto", () => {
    const router = new Router();
    router.setPin("escalation");
    router.route({ prompt: "x" });
    router.setPin("auto");

    expect(router.route({ prompt: "add a check" }).layer).toBe("flash");
  });
});

describe("Router accounting", () => {
  it("tracks escalation share over tokens", () => {
    const router = new Router();
    router.recordUsage("flash", tokens(900));
    router.recordUsage("escalation", tokens(100));

    expect(router.escalationShare).toBeCloseTo(0.1, 6);
    expect(router.withinEscalationLimit).toBe(true);
  });

  it("flags a breach of the SPEC §4.5 invariant", () => {
    const router = new Router();
    router.recordUsage("flash", tokens(800));
    router.recordUsage("escalation", tokens(200));

    expect(router.escalationShare).toBeGreaterThan(ESCALATION_TOKEN_LIMIT);
    expect(router.withinEscalationLimit).toBe(false);
  });

  it("accepts a run exactly at the limit", () => {
    const router = new Router();
    router.recordUsage("flash", tokens(850));
    router.recordUsage("escalation", tokens(150));

    expect(router.withinEscalationLimit).toBe(true);
  });

  it("tracks local share for the SPEC §6 KPI", () => {
    const router = new Router();
    router.recordUsage("local", tokens(300));
    router.recordUsage("flash", tokens(700));

    expect(router.localShare).toBeCloseTo(0.3, 6);
  });

  it("returns zero shares rather than NaN before any usage", () => {
    const router = new Router();

    expect(router.escalationShare).toBe(0);
    expect(router.localShare).toBe(0);
    expect(router.withinEscalationLimit).toBe(true);
  });

  it("exposes a snapshot for /cost and the layer badge", () => {
    const router = new Router();
    router.recordResult(false);

    expect(router.snapshot()).toMatchObject({
      layer: "flash",
      pinned: "auto",
      escalated: false,
      consecutiveFailures: 1,
    });
  });
});
