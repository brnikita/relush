import type { TokenUsage } from "@nodrel/telemetry";
import { describe, expect, it } from "vitest";
import {
  ALL_MODELS,
  blendedCostPerMillion,
  costOf,
  ESCALATION,
  FLASH,
  FREE_CHAIN,
  findModel,
} from "./models.ts";
import {
  countTextTokens,
  estimatePromptTokens,
  estimateToolTokens,
  MESSAGE_OVERHEAD_TOKENS,
  REQUEST_OVERHEAD_TOKENS,
} from "./tokenize.ts";

describe("tokenize", () => {
  it("counts bare text without a chat envelope", () => {
    expect(countTextTokens("hello world")).toBe(2);
  });

  it("adds request and per-message envelope overhead", () => {
    const one = estimatePromptTokens([{ role: "user", content: "alpha beta gamma delta" }]);
    const two = estimatePromptTokens([
      { role: "user", content: "alpha beta gamma delta" },
      { role: "assistant", content: "epsilon zeta eta theta" },
    ]);

    expect(one).toBeGreaterThan(countTextTokens("alpha beta gamma delta"));
    // A second message costs roughly one more envelope unit, not a second
    // full request overhead.
    expect(two - one).toBeLessThan(REQUEST_OVERHEAD_TOKENS);
  });

  it("reproduces the live calibration within 2% on a realistic prompt", () => {
    // Measured against z-ai/glm-5.3-flash during F6: content of 425 local
    // tokens reported 436 prompt_tokens.
    const content = "The quick brown fox jumps over the lazy dog. ".repeat(40);
    const local = countTextTokens(content);
    const estimate = estimatePromptTokens([{ role: "user", content }]);

    expect(local).toBe(401);
    // Estimate must land near the observed 413 for this exact input.
    expect(Math.abs(estimate - 413) / 413).toBeLessThan(0.02);
  });

  it("rounds up, so a budget check never lets an over-budget request through", () => {
    const estimate = estimatePromptTokens([{ role: "user", content: "x" }]);

    expect(Number.isInteger(estimate)).toBe(true);
    expect(estimate).toBeGreaterThanOrEqual(
      countTextTokens("x") + REQUEST_OVERHEAD_TOKENS + MESSAGE_OVERHEAD_TOKENS,
    );
  });

  it("measures tool schemas as serialized JSON, not description prose", () => {
    const tool = {
      name: "read",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    };

    // The JSON envelope is what is sent, so it must be counted.
    expect(estimateToolTokens(tool)).toBeGreaterThan(countTextTokens(tool.description));
  });
});

describe("model registry", () => {
  it("prices cached input below fresh input on the default model", () => {
    // This ratio is the economic case for prefix pinning (SPEC §4.4).
    expect(FLASH.cost.cacheRead).toBeLessThan(FLASH.cost.input);
    expect(FLASH.cost.input / FLASH.cost.cacheRead).toBeCloseTo(5, 0);
  });

  it("keeps the escalation model more expensive than flash", () => {
    // If this inverts, the router's whole cost model is wrong.
    expect(ESCALATION.cost.input).toBeGreaterThan(FLASH.cost.input);
    expect(ESCALATION.cost.output).toBeGreaterThan(FLASH.cost.output);
  });

  it("marks every free-chain model as free and zero-cost", () => {
    for (const model of FREE_CHAIN) {
      expect(model.free, model.id).toBe(true);
      expect(costOf(model, { input: 1000, cached: 1000, output: 1000 }), model.id).toBe(0);
    }
  });

  it("excludes glm-5.2:free from the chain despite its benchmark strength", () => {
    // It returned upstream_429 during F0; ordering is by observed reliability.
    expect(FREE_CHAIN.some((m) => m.id === "z-ai/glm-5.2:free")).toBe(false);
  });

  it("looks models up by id", () => {
    expect(findModel("z-ai/glm-5.3-flash")).toBe(FLASH);
    expect(findModel("nope")).toBeUndefined();
  });

  it("gives every model a positive context length", () => {
    for (const model of ALL_MODELS) expect(model.contextLength, model.id).toBeGreaterThan(0);
  });
});

describe("cost", () => {
  const usage: TokenUsage = { input: 1_000_000, cached: 0, output: 0 };

  it("bills a million fresh input tokens at the published rate", () => {
    expect(costOf(FLASH, usage)).toBeCloseTo(0.075, 6);
  });

  it("bills cached input at the cache rate, not the input rate", () => {
    const cached = costOf(FLASH, { input: 0, cached: 1_000_000, output: 0 });

    expect(cached).toBeCloseTo(0.015, 6);
    // Charging cached tokens as input would hide the benefit of prefix pinning.
    expect(cached).toBeLessThan(costOf(FLASH, usage));
  });

  it("blends toward the SPEC §1 target of ~$0.10 per million on flash", () => {
    // A cache-heavy, output-light step — the shape nodrel is designed to produce.
    const blended = blendedCostPerMillion(FLASH, {
      input: 100_000,
      cached: 900_000,
      output: 20_000,
    });

    expect(blended).toBeLessThan(0.1);
  });

  it("returns zero for an empty step rather than dividing by zero", () => {
    expect(blendedCostPerMillion(FLASH, { input: 0, cached: 0, output: 0 })).toBe(0);
  });
});
