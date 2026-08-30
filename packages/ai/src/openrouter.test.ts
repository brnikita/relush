import { describe, expect, it, vi } from "vitest";
import { FLASH, FREE_CHAIN, type ModelSpec } from "./models.ts";
import {
  ChainExhaustedError,
  OpenRouterClient,
  ProviderError,
  toTokenUsage,
  wasTruncatedBeforeAnswering,
} from "./openrouter.ts";

const ok = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response;

const httpError = (status: number, message?: string): Response =>
  ({
    ok: false,
    status,
    json: async () => (message === undefined ? {} : { error: { message, code: status } }),
  }) as Response;

const completion = (text: string, usage?: Record<string, unknown>) => ({
  choices: [{ message: { content: text } }],
  usage: { prompt_tokens: 100, completion_tokens: 10, ...usage },
});

const client = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) =>
  new OpenRouterClient({
    apiKey: "test-key",
    fetchImpl,
    sleep: async () => {},
    ...extra,
  });

const req = { messages: [{ role: "user" as const, content: "hi" }] };

describe("toTokenUsage", () => {
  it("splits cached tokens out of prompt_tokens", () => {
    // OpenRouter reports prompt_tokens inclusive of cached. Leaving them merged
    // would make the cache-hit KPI unmeasurable and overcharge cached tokens.
    const usage = toTokenUsage({
      prompt_tokens: 1000,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 900 },
    });

    expect(usage).toEqual({ input: 100, cached: 900, output: 50 });
  });

  it("treats absent cache details as no cache hit", () => {
    expect(toTokenUsage({ prompt_tokens: 100, completion_tokens: 5 })).toEqual({
      input: 100,
      cached: 0,
      output: 5,
    });
  });

  it("never reports negative input if cached exceeds prompt", () => {
    const usage = toTokenUsage({
      prompt_tokens: 10,
      prompt_tokens_details: { cached_tokens: 50 },
    });

    expect(usage.input).toBe(0);
  });

  it("defaults to zeros when the provider omits usage", () => {
    expect(toTokenUsage(undefined)).toEqual({ input: 0, cached: 0, output: 0 });
  });
});

describe("OpenRouterClient fallback", () => {
  it("returns the first model's answer without falling back", async () => {
    const fetchImpl = vi.fn(async () => ok(completion("hello")));

    const result = await client(fetchImpl as unknown as typeof fetch).complete(FREE_CHAIN, req);

    expect(result.text).toBe("hello");
    expect(result.model.id).toBe(FREE_CHAIN[0]?.id);
    expect(result.fallbacksFrom).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to the next model after a 429, and reports what it skipped", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      // First model fails both attempts, second answers.
      return call <= 2 ? httpError(429) : ok(completion("recovered"));
    });

    const result = await client(fetchImpl as unknown as typeof fetch).complete(FREE_CHAIN, req);

    expect(result.text).toBe("recovered");
    expect(result.model.id).toBe(FREE_CHAIN[1]?.id);
    expect(result.fallbacksFrom).toEqual([FREE_CHAIN[0]?.id]);
  });

  it("retries the same model before moving on, since pool 429s are transient", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call === 1 ? httpError(429) : ok(completion("second try"));
    });

    const result = await client(fetchImpl as unknown as typeof fetch).complete(FREE_CHAIN, req);

    expect(result.model.id).toBe(FREE_CHAIN[0]?.id);
    expect(result.fallbacksFrom).toEqual([]);
  });

  it("does not fall back on 401, because every model would fail the same way", async () => {
    const fetchImpl = vi.fn(async () => httpError(401));

    await expect(
      client(fetchImpl as unknown as typeof fetch).complete(FREE_CHAIN, req),
    ).rejects.toThrow(ProviderError);
    // One attempt, not six: a bad key is not a reason to spam the chain.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not fall back on 400, a malformed request", async () => {
    const fetchImpl = vi.fn(async () => httpError(400));

    await expect(
      client(fetchImpl as unknown as typeof fetch).complete(FREE_CHAIN, req),
    ).rejects.toThrow(/HTTP 400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("treats an error inside a 200 body as a provider failure", async () => {
    // OpenRouter returns upstream_429 this way; status alone is insufficient.
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call <= 2
        ? ok({ error: { message: "temporarily rate-limited upstream", code: 429 } })
        : ok(completion("recovered"));
    });

    const result = await client(fetchImpl as unknown as typeof fetch).complete(FREE_CHAIN, req);

    expect(result.model.id).toBe(FREE_CHAIN[1]?.id);
  });

  it("reports every failure when the whole chain is exhausted", async () => {
    const fetchImpl = vi.fn(async () => httpError(503));

    const error = await client(fetchImpl as unknown as typeof fetch)
      .complete(FREE_CHAIN, req)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ChainExhaustedError);
    expect((error as ChainExhaustedError).failures).toHaveLength(FREE_CHAIN.length);
  });

  it("rejects an empty chain rather than silently doing nothing", async () => {
    const fetchImpl = vi.fn(async () => ok(completion("unused")));

    await expect(client(fetchImpl as unknown as typeof fetch).complete([], req)).rejects.toThrow(
      ChainExhaustedError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("OpenRouterClient accounting", () => {
  it("emits a telemetry step with split token buckets and real cost", async () => {
    const steps: { costUsd: number; layer: string; tokens: unknown }[] = [];
    const fetchImpl = vi.fn(async () =>
      ok(
        completion("x", {
          prompt_tokens: 1_000_000,
          completion_tokens: 0,
          prompt_tokens_details: { cached_tokens: 0 },
        }),
      ),
    );

    await client(fetchImpl as unknown as typeof fetch, {
      onStep: (e: { costUsd: number; layer: string; tokens: unknown }) => steps.push(e),
    }).complete([FLASH], req);

    expect(steps).toHaveLength(1);
    expect(steps[0]?.layer).toBe("flash");
    expect(steps[0]?.costUsd).toBeCloseTo(0.075, 6);
  });

  it("costs a free model at zero even with large usage", async () => {
    const steps: { costUsd: number }[] = [];
    const fetchImpl = vi.fn(async () =>
      ok(completion("x", { prompt_tokens: 500_000, completion_tokens: 5_000 })),
    );
    const free = FREE_CHAIN[0] as ModelSpec;

    await client(fetchImpl as unknown as typeof fetch, {
      onStep: (e: { costUsd: number }) => steps.push(e),
    }).complete([free], req);

    expect(steps[0]?.costUsd).toBe(0);
  });

  it("parses tool calls out of the response", async () => {
    const fetchImpl = vi.fn(async () =>
      ok({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: "c1", function: { name: "read", arguments: '{"path":"a.ts"}' } }],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );

    const result = await client(fetchImpl as unknown as typeof fetch).complete([FLASH], req);

    expect(result.toolCalls).toEqual([{ id: "c1", name: "read", arguments: '{"path":"a.ts"}' }]);
    expect(result.text).toBe("");
  });

  it("sends tools in OpenAI function form when provided", async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      return ok(completion("x"));
    });

    await client(fetchImpl as unknown as typeof fetch).complete([FLASH], {
      ...req,
      tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
    });

    expect(sent["tool_choice"]).toBe("auto");
    expect((sent["tools"] as { type: string }[])[0]?.type).toBe("function");
  });
});

describe("model-specific rejections", () => {
  it("falls through a 400 that names an invalid model id", async () => {
    // OpenRouter rejects an unknown model this way. It is model-specific, so a
    // single retired id in a chain must not abort the whole request.
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call <= 2
        ? httpError(400, "nonexistent/model:free is not a valid model ID")
        : ok(completion("recovered"));
    });

    const result = await client(fetchImpl as unknown as typeof fetch).complete(FREE_CHAIN, req);

    expect(result.model.id).toBe(FREE_CHAIN[1]?.id);
    expect(result.fallbacksFrom).toEqual([FREE_CHAIN[0]?.id]);
  });

  it("still refuses to fall through a 400 for a malformed request", async () => {
    const fetchImpl = vi.fn(async () => httpError(400, "messages: field required"));

    await expect(
      client(fetchImpl as unknown as typeof fetch).complete(FREE_CHAIN, req),
    ).rejects.toThrow(/field required/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("includes the provider message in the error, not just a status code", async () => {
    const fetchImpl = vi.fn(async () => httpError(401, "invalid api key"));

    await expect(
      client(fetchImpl as unknown as typeof fetch).complete(FREE_CHAIN, req),
    ).rejects.toThrow(/invalid api key/);
  });
});

describe("reasoning models", () => {
  it("flags a response truncated before it produced an answer", () => {
    // Reasoning models spend the completion budget thinking; returning "" with
    // no signal would look like a model that ignored the prompt.
    const truncated = {
      text: "",
      toolCalls: [],
      finishReason: "length",
    } as unknown as Parameters<typeof wasTruncatedBeforeAnswering>[0];

    expect(wasTruncatedBeforeAnswering(truncated)).toBe(true);
  });

  it("does not flag a normal empty answer that stopped cleanly", () => {
    const stopped = {
      text: "",
      toolCalls: [],
      finishReason: "stop",
    } as unknown as Parameters<typeof wasTruncatedBeforeAnswering>[0];

    expect(wasTruncatedBeforeAnswering(stopped)).toBe(false);
  });

  it("surfaces reasoning text and reasoning token counts", async () => {
    const fetchImpl = vi.fn(async () =>
      ok({
        choices: [
          { finish_reason: "length", message: { content: null, reasoning: "thinking hard" } },
        ],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 16,
          completion_tokens_details: { reasoning_tokens: 16 },
        },
      }),
    );

    const result = await client(fetchImpl as unknown as typeof fetch).complete([FLASH], req);

    expect(result.reasoning).toBe("thinking hard");
    expect(result.reasoningTokens).toBe(16);
    expect(wasTruncatedBeforeAnswering(result)).toBe(true);
  });
});
