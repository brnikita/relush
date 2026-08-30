import { describe, expect, it } from "vitest";
import { FLASH } from "./models.ts";
import { estimatePromptTokens } from "./tokenize.ts";

/**
 * F6's gate: local token estimates must match provider-reported usage within 2%.
 *
 * Excluded from the default run and from CI (see `vitest.config.ts` and
 * `docs/testing.md`) because it makes real, billed provider calls.
 *
 * Run locally with a populated `.env`:
 *   pnpm vitest --run packages/ai/src/tokenize.live.test.ts
 */

const KEY = process.env["OPENROUTER_API_KEY"];

interface CompletionResponse {
  usage?: { prompt_tokens: number };
  error?: { message: string };
}

async function promptTokens(content: string): Promise<number> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: FLASH.id,
      messages: [{ role: "user", content }],
      max_tokens: 1,
    }),
  });

  const body = (await response.json()) as CompletionResponse;
  if (body.error) throw new Error(`provider error: ${body.error.message}`);
  if (!body.usage) throw new Error("provider returned no usage");
  return body.usage.prompt_tokens;
}

describe.skipIf(!KEY)("tokenizer calibration against live provider", () => {
  it.each([
    ["prose", "The quick brown fox jumps over the lazy dog. ".repeat(40)],
    [
      "code",
      "export class GraphStore {\n  private db: Database;\n  constructor(path: string) {\n    this.db = new Database(path);\n  }\n  async query(q: string): Promise<Row[]> {\n    return this.db.all(q);\n  }\n}\n".repeat(
        8,
      ),
    ],
    [
      "json",
      JSON.stringify({
        nodes: Array.from({ length: 60 }, (_, i) => ({
          id: i,
          name: `fn_${i}`,
          kind: "function",
        })),
      }),
    ],
  ])("estimates %s within 2%% of provider-reported usage", async (_label, content) => {
    const actual = await promptTokens(content);
    const estimate = estimatePromptTokens([{ role: "user", content }]);
    const error = Math.abs(estimate - actual) / actual;

    expect(
      error,
      `estimate ${estimate} vs provider ${actual} (${(error * 100).toFixed(2)}% error)`,
    ).toBeLessThan(0.02);
  });
});
