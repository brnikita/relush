import { CORE_TOOLS } from "@nodrel/core";
import { describe, expect, it } from "vitest";
import { FLASH, FREE_CHAIN } from "./models.ts";
import { OpenRouterClient, wasTruncatedBeforeAnswering } from "./openrouter.ts";

/**
 * F8's gate: a live tool call must succeed through the fallback chain.
 *
 * Excluded from `pnpm test` and CI — see docs/testing.md. Run with:
 *   pnpm test:live
 */

const KEY = process.env["OPENROUTER_API_KEY"];

const client = () => new OpenRouterClient({ apiKey: KEY ?? "", timeoutMs: 60_000 });

const toolDefs = CORE_TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  parameters: t.parameters,
}));

describe.skipIf(!KEY)("OpenRouterClient against the live provider", () => {
  it("completes a plain request through the free chain", async () => {
    const result = await client().complete(FREE_CHAIN, {
      messages: [{ role: "user", content: "Reply with exactly: ok" }],
      maxTokens: 600,
    });

    // Several free-chain models are reasoning models: they spend the completion
    // budget thinking before answering, so a truncated response is a budget
    // problem, not a wrong answer.
    expect(wasTruncatedBeforeAnswering(result), "response truncated before answering").toBe(false);
    expect(result.text.toLowerCase()).toContain("ok");
    expect(result.tokens.output).toBeGreaterThan(0);
    expect(result.costUsd).toBe(0);
  });

  it("produces a real tool call from the core tool schemas", async () => {
    const result = await client().complete(FREE_CHAIN, {
      messages: [
        {
          role: "user",
          content: "Read the file src/index.ts. Use a tool; do not answer in prose.",
        },
      ],
      tools: toolDefs,
      maxTokens: 256,
    });

    expect(result.toolCalls.length).toBeGreaterThan(0);
    const call = result.toolCalls[0];
    expect(CORE_TOOLS.map((t) => t.name)).toContain(call?.name);
    expect(() => JSON.parse(call?.arguments ?? "")).not.toThrow();
  });

  it("reports real usage and cost on the paid flash model", async () => {
    const result = await client().complete([FLASH], {
      messages: [{ role: "user", content: "Reply with exactly: ok" }],
      maxTokens: 600,
    });

    expect(result.model.id).toBe(FLASH.id);
    expect(result.tokens.input + result.tokens.cached).toBeGreaterThan(0);
    // Flash is cheap but not free; a zero here means cost accounting is broken.
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.latencyMs).toBeGreaterThan(0);
  });

  it("falls through a known-bad model id to a working one", async () => {
    // Proves the chain recovers from a real provider rejection, not just a
    // mocked one. A nonexistent model is rejected upstream.
    const bogus = { ...FREE_CHAIN[0], id: "nonexistent/model-that-does-not-exist:free" } as const;

    const result = await client().complete([bogus, ...FREE_CHAIN], {
      messages: [{ role: "user", content: "Reply with exactly: ok" }],
      maxTokens: 600,
    });

    expect(result.fallbacksFrom).toContain(bogus.id);
    expect(result.text.toLowerCase()).toContain("ok");
  });
});
