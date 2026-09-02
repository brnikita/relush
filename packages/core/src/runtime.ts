import {
  Agent,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Model } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { composeHooks } from "./compose.ts";
import type { Extension } from "./extensions.ts";
import { createGraphQueryTool, type GraphToolDeps } from "./graph-tool.ts";
import { PINNED_INSTRUCTIONS, SYSTEM_PROMPT } from "./prompt.ts";

const NL_ = String.fromCharCode(10);

/**
 * Assembles a runnable agent (SPEC §4.1).
 *
 * This is the "harness of record" the M0 baseline is measured against: Pi's
 * agent loop and its `read`/`write`/`edit`/`bash` implementations, driven by
 * OpenRouter, with nodrel's extensions attached through the hooks validated in
 * ADR-002.
 *
 * Notably absent is `graph_query` — the context engine lands in Phase 3. Its
 * absence here is deliberate: the baseline has to represent an *unoptimized*
 * harness, or the improvement it is compared against is not real.
 */

/**
 * Adapts an `AgentHarnessTool` to the `AgentTool` the agent loop expects.
 *
 * The two differ in one place: a harness tool takes an execution context as a
 * final `execute` argument, while the loop calls tools without one. Binding the
 * context here is what confines the tools to a single working directory, and
 * doing it once means a tool can never be registered without an environment.
 */
function bindToolContext<TContext extends object>(
  tool: { execute: (...args: never[]) => unknown },
  context: TContext,
): unknown {
  return {
    ...tool,
    execute: (
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: unknown,
    ): unknown =>
      (tool.execute as unknown as (...a: unknown[]) => unknown)(
        toolCallId,
        params,
        signal,
        onUpdate,
        context,
      ),
  };
}

export interface CreateAgentOptions {
  /** OpenRouter model id, e.g. `z-ai/glm-5.3-flash`. */
  readonly modelId: string;
  readonly apiKey: string;
  /** Working directory the tools operate in. */
  readonly cwd: string;
  readonly extensions?: readonly Extension[];
  readonly systemPrompt?: string;
  readonly sessionId?: string;
  /**
   * Enables `graph_query` against an indexed store.
   *
   * Omitted, the agent runs with the four file/shell tools only -- which is
   * what the P1 baseline measured, and what any graph comparison is against.
   */
  readonly graph?: GraphToolDeps;
  /**
   * Cap on completion tokens per request.
   *
   * Pi defaults to the model's maximum, and OpenRouter pre-authorises that
   * amount against the account balance -- so a 128k default is refused with a
   * 402 the moment credits run low, regardless of how short the answer would
   * have been. 8k is far above any agent turn and keeps the pre-auth honest.
   */
  readonly maxTokens?: number;
  /**
   * Pinned context appended to the system prompt: repository conventions and
   * the task map (SPEC §4.3). Part of the cached prefix, so it must be
   * byte-stable for the whole session -- compute it once, never per turn.
   */
  readonly pinnedContext?: string;
}

export class ModelNotFoundError extends Error {
  constructor(modelId: string) {
    super(`model not available from openrouter: ${modelId}`);
    this.name = "ModelNotFoundError";
  }
}

/** Looks a model up in OpenRouter's catalogue. */
export function resolveModel(modelId: string): Model<never> {
  const provider = openrouterProvider();
  const model = provider.getModels().find((m) => m.id === modelId);
  if (!model) throw new ModelNotFoundError(modelId);
  // Pi emits `max_completion_tokens` by default, but OpenRouter pre-authorises
  // the request against the balance using `max_tokens` -- which then falls back
  // to the model's 128k maximum and is refused with a 402 the moment credits
  // run low, however short the answer would be. Forcing the field keeps the
  // cap we set and the cap OpenRouter checks the same number.
  const compat = (model as unknown as { compat?: Record<string, unknown> }).compat ?? {};
  return { ...model, compat: { ...compat, maxTokensField: "max_tokens" } } as Model<never>;
}

/**
 * Builds an `Agent` wired to OpenRouter with the four file/shell tools.
 *
 * The API key is passed through `getApiKey` rather than an environment
 * variable so a single process can drive several keys — the BYOK path in
 * SPEC §4.8 needs that, and reading `process.env` deep in a provider makes it
 * impossible.
 */
export function createAgent(options: CreateAgentOptions): Agent {
  const provider = openrouterProvider();
  const model = resolveModel(options.modelId);
  const env = new NodeExecutionEnv({ cwd: options.cwd });
  const hooks = composeHooks(options.extensions ?? []);

  // Tools resolve paths and run commands through this environment, so it is
  // what confines the agent to the working directory.
  const toolContext = { env };
  const tools: unknown[] = [
    createReadTool(),
    createWriteTool(),
    createEditTool(),
    createBashTool(),
  ].map((tool) => bindToolContext(tool as never, toolContext));

  // graph_query needs no execution environment: it answers from the index.
  if (options.graph) tools.push(createGraphQueryTool(options.graph));

  return new Agent({
    streamFn: ((model: unknown, context: unknown, opts?: Record<string, unknown>) =>
      provider.streamSimple(
        model as never,
        context as never,
        {
          ...opts,
          maxTokens: options.maxTokens ?? 8192,
        } as never,
      )) as never,
    getApiKey: () => options.apiKey,
    initialState: {
      systemPrompt: [
        options.systemPrompt ?? SYSTEM_PROMPT,
        PINNED_INSTRUCTIONS,
        options.pinnedContext,
      ]
        .filter((part): part is string => typeof part === "string" && part !== "")
        .join(`${NL_}${NL_}`),
      model,
      tools,
    } as never,
    transformContext: hooks.transformContext,
    beforeToolCall: hooks.beforeToolCall,
    afterToolCall: hooks.afterToolCall,
    prepareNextTurnWithContext: hooks.prepareNextTurnWithContext,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
  });
}
