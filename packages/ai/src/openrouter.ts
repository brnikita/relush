import type { StepEvent, TokenUsage } from "@nodrel/telemetry";
import { costOf, type ModelSpec } from "./models.ts";

/**
 * OpenRouter provider with layer fallback (SPEC §4.5, §4.8).
 *
 * The fallback chain is not a nicety. Free models sit in a shared upstream pool
 * and return `upstream_429` unpredictably — during F0 the strongest free model
 * failed on its first call while three others answered correctly. A client that
 * targets a single model id is therefore unreliable by construction.
 *
 * Fallback fires on conditions that another model can plausibly fix — rate
 * limits, upstream outages, timeouts, and a rejected model id. It deliberately
 * does **not** fire on 401 or on a malformed-request 400: a bad key or a bad
 * body fails identically on every model, and retrying would turn one clear
 * error into N confusing ones.
 */

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
}

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly tool_call_id?: string;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface CompletionRequest {
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolDefinition[];
  readonly maxTokens?: number;
  /** Forwarded as `user` so cache-aware backends can key on the session. */
  readonly sessionId?: string;
}

export interface CompletionResult {
  readonly model: ModelSpec;
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly tokens: TokenUsage;
  readonly costUsd: number;
  readonly latencyMs: number;
  /** Models tried and rejected before this one answered. */
  readonly fallbacksFrom: readonly string[];
  /**
   * Reasoning trace, when the model emits one separately from `text`.
   *
   * Several models in the free chain are reasoning models. They spend the
   * completion budget on reasoning first, so a small `maxTokens` can yield
   * `finishReason: "length"` with empty `text` — the answer was never reached.
   */
  readonly reasoning: string;
  /** Provider stop reason. `"length"` means the response was truncated. */
  readonly finishReason: string | undefined;
  /** Reasoning tokens, a subset of `tokens.output`. */
  readonly reasoningTokens: number;
}

/**
 * A model produced no content because the token budget was spent reasoning.
 *
 * Worth its own signal: the fix is a larger `maxTokens`, not a different model,
 * and silently returning `""` would look like a model that ignored the prompt.
 */
export const wasTruncatedBeforeAnswering = (result: CompletionResult): boolean =>
  result.finishReason === "length" && result.text === "" && result.toolCalls.length === 0;

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Every model in the chain failed. Carries each failure for diagnosis. */
export class ChainExhaustedError extends Error {
  constructor(readonly failures: readonly { model: string; error: string }[]) {
    super(
      `all ${failures.length} models failed: ${failures.map((f) => `${f.model} (${f.error})`).join("; ")}`,
    );
    this.name = "ChainExhaustedError";
  }
}

/**
 * Whether another model could plausibly succeed where this one failed.
 *
 * 429 and 5xx are upstream-specific. 408 is a timeout. Everything else —
 * notably 401 (bad key) and 400 (malformed request) — is our fault and will
 * reproduce on every model.
 */
const isRetryable = (status: number): boolean => status === 429 || status === 408 || status >= 500;

/**
 * A 400 that is the *model's* fault rather than the request's.
 *
 * OpenRouter rejects an unknown model id with `400 "<id> is not a valid model
 * ID"`. That is model-specific, so the chain should move on — unlike a 400 for
 * a malformed body, which every model would reject identically. Without this
 * distinction a single retired model id in a chain aborts the whole request.
 */
const isModelSpecificRejection = (status: number | undefined, message: string): boolean =>
  status === 400 && /not a valid model|model not found|no endpoints found/i.test(message);

interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

interface OpenRouterResponse {
  choices?: {
    finish_reason?: string;
    message?: {
      content?: string | null;
      reasoning?: string | null;
      tool_calls?: { id: string; function: { name: string; arguments: string } }[];
    };
  }[];
  usage?: OpenRouterUsage;
  error?: { message?: string; code?: number };
}

/** Provider usage → our `TokenUsage`, keeping cached input as its own bucket. */
export function toTokenUsage(usage: OpenRouterUsage | undefined): TokenUsage {
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const prompt = usage?.prompt_tokens ?? 0;
  return {
    // OpenRouter reports prompt_tokens inclusive of cached; split them so the
    // cache-hit KPI stays measurable and cached tokens bill at the cache rate.
    input: Math.max(0, prompt - cached),
    cached,
    output: usage?.completion_tokens ?? 0,
  };
}

export interface ClientOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  /** Wall-clock cap per attempt. */
  readonly timeoutMs?: number;
  /** Injected for tests. */
  readonly fetchImpl?: typeof fetch;
  /** Called once per successful step, for telemetry. */
  readonly onStep?: (event: Omit<StepEvent, "sessionId" | "type">) => void;
  /** Injected for tests; defaults to real delay. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class OpenRouterClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onStep: ((event: Omit<StepEvent, "sessionId" | "type">) => void) | undefined;

  constructor(options: ClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? "https://openrouter.ai/api/v1";
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.onStep = options.onStep;
  }

  /**
   * Completes a request, walking `chain` until one model answers.
   *
   * Each model gets `attemptsPerModel` tries with exponential backoff before
   * the chain moves on, because a 429 from a shared pool is often transient.
   */
  async complete(
    chain: readonly ModelSpec[],
    request: CompletionRequest,
    attemptsPerModel = 2,
  ): Promise<CompletionResult> {
    if (chain.length === 0) throw new ChainExhaustedError([]);

    const failures: { model: string; error: string }[] = [];
    const fallbacksFrom: string[] = [];

    for (const model of chain) {
      for (let attempt = 0; attempt < attemptsPerModel; attempt++) {
        try {
          return await this.attempt(model, request, fallbacksFrom);
        } catch (error) {
          const providerError =
            error instanceof ProviderError
              ? error
              : new ProviderError(String((error as Error).message ?? error), undefined, true);

          const lastAttempt = attempt === attemptsPerModel - 1;
          if (!providerError.retryable) throw providerError;

          if (lastAttempt) {
            failures.push({ model: model.id, error: providerError.message });
            fallbacksFrom.push(model.id);
          } else {
            // 200ms, 400ms, … — enough for a shared pool to drain, short
            // enough not to stall an interactive session.
            await this.sleep(200 * 2 ** attempt);
          }
        }
      }
    }

    throw new ChainExhaustedError(failures);
  }

  private async attempt(
    model: ModelSpec,
    request: CompletionRequest,
    fallbacksFrom: readonly string[],
  ): Promise<CompletionResult> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: model.id,
          messages: request.messages,
          ...(request.tools
            ? {
                tools: request.tools.map((t) => ({
                  type: "function",
                  function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                  },
                })),
                tool_choice: "auto",
              }
            : {}),
          ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
          ...(request.sessionId === undefined ? {} : { user: request.sessionId }),
        }),
        signal: controller.signal,
      });
    } catch (error) {
      // Aborts and network failures are both worth trying elsewhere.
      throw new ProviderError(`request failed: ${(error as Error).message}`, undefined, true);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // Read the body even on an error status: OpenRouter distinguishes an
      // unknown model id from a malformed request only in the message, and
      // that distinction decides whether the chain moves on.
      const detail = await response
        .json()
        .then((b) => (b as OpenRouterResponse).error?.message ?? "")
        .catch(() => "");

      const message =
        detail === "" ? `HTTP ${response.status}` : `HTTP ${response.status}: ${detail}`;
      throw new ProviderError(
        message,
        response.status,
        isRetryable(response.status) || isModelSpecificRejection(response.status, detail),
      );
    }

    const body = (await response.json()) as OpenRouterResponse;

    // OpenRouter can return an error inside a 200 when the upstream provider
    // rejects, so status alone is not sufficient.
    if (body.error) {
      const status = body.error.code;
      const message = body.error.message ?? "provider error";
      throw new ProviderError(
        message,
        status,
        status === undefined
          ? true
          : isRetryable(status) || isModelSpecificRejection(status, message),
      );
    }

    const choice = body.choices?.[0];
    const message = choice?.message;
    const tokens = toTokenUsage(body.usage);
    const latencyMs = Date.now() - started;
    const costUsd = costOf(model, tokens);

    this.onStep?.({
      ts: new Date().toISOString(),
      stepId: `${model.id}-${started}`,
      layer: model.layer,
      model: model.id,
      provider: "openrouter",
      tokens,
      costUsd,
      latencyMs,
    });

    return {
      model,
      text: message?.content ?? "",
      reasoning: message?.reasoning ?? "",
      finishReason: choice?.finish_reason,
      reasoningTokens: body.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      toolCalls: (message?.tool_calls ?? []).map((c) => ({
        id: c.id,
        name: c.function.name,
        arguments: c.function.arguments,
      })),
      tokens,
      costUsd,
      latencyMs,
      fallbacksFrom,
    };
  }
}
