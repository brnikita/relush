import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { countTextTokens, findModel } from "@nodrel/ai";
import { buildTaskMap } from "@nodrel/context";
import type { Extension } from "@nodrel/core";
import { createAgent, createPermissionGuard, resolveModel } from "@nodrel/core";
import { indexFiles, resolveCrossFileCalls, SqliteGraphStore } from "@nodrel/graph";
import { createHistoryExtension } from "@nodrel/history";
import type { StepEvent, TelemetryEvent } from "@nodrel/telemetry";
import { aggregate } from "@nodrel/telemetry";

/**
 * Runs one eval task and reports what it cost (SPEC §4.9).
 *
 * The eval harness (Python, per SPEC §4.9) shells out to this per task and
 * reads the JSON on stdout. Keeping the boundary at one task rather than one
 * suite means a crashed or hung task cannot take a whole run with it, and the
 * harness stays free to parallelize.
 */

export interface TaskRunOptions {
  readonly prompt: string;
  readonly cwd: string;
  readonly modelId: string;
  readonly apiKey: string;
  /** Wall-clock cap for the whole task. */
  readonly timeoutMs?: number;
  /**
   * Enable the history manager (masking).
   *
   * Off by default so the M0 baseline measures an unoptimized harness. The
   * eval harness flips it on to measure what masking is actually worth, which
   * only means anything if both sides run the same tasks the same way.
   */
  readonly history?: boolean;
  /**
   * Index the working directory and expose `graph_query`.
   *
   * Off by default so the baseline measures a harness without it, which is what
   * any comparison has to be against.
   */
  readonly graph?: boolean;
  readonly maxTokens?: number;
  /**
   * Models to try in order if a run ends in a provider error.
   *
   * Free models sit in a shared upstream pool and fail unpredictably: in one
   * probe three of four returned 429 or "service temporarily unavailable"
   * while the fourth worked. A single-model runner would report those as task
   * failures and corrupt the solve rate with provider weather.
   */
  readonly fallbackModels?: readonly string[];
}

export interface TaskRunResult {
  readonly ok: boolean;
  readonly sessionId: string;
  readonly turns: number;
  readonly toolCalls: readonly string[];
  readonly tokens: { input: number; cached: number; output: number };
  readonly costUsd: number;
  readonly wallMs: number;
  readonly cacheHitRate: number;
  /** Outputs compacted, and what the placeholders cost instead. */
  readonly masked: { count: number; tokensBefore: number; tokensAfter: number };
  /** Compaction modes the session entered, for diagnosing a null result. */
  readonly compactionModes: readonly string[];
  /** graph_query calls made, and what they cost. */
  readonly graphQueries: { count: number; tokens: number; results: number };
  /** Model that actually produced the result, after any fallback. */
  readonly modelId: string;
  /** Models that failed with a provider error before this one. */
  readonly fallbacksFrom: readonly string[];
  readonly error?: string;
}

/**
 * Indexes the working directory into an in-memory graph.
 *
 * In memory rather than `.agent/graph/`: an eval task runs once in a throwaway
 * directory, so persistence would only add I/O. A real session persists.
 */
async function buildGraph(cwd: string) {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(cwd);

  const store = new SqliteGraphStore({ path: ":memory:" });
  store.init();
  await indexFiles(store, cwd, files);
  resolveCrossFileCalls(store);
  return store;
}

/** Usage as pi-ai reports it, which splits cache reads and writes. */
interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

/**
 * Runs the task to completion and returns its cost.
 *
 * Errors are captured into the result rather than thrown: a task that fails is
 * a data point the report needs, not an exception that should abort the suite.
 */
/**
 * Runs the task, moving down the fallback chain on provider errors.
 *
 * Each attempt is a fresh agent on the same working directory. A provider error
 * on the first turn leaves the directory untouched; one mid-task may leave
 * partial edits, which the next model then sees -- acceptable, because the
 * alternative is counting provider weather as a failed task.
 */
export async function runTask(options: TaskRunOptions): Promise<TaskRunResult> {
  const chain = [options.modelId, ...(options.fallbackModels ?? [])];
  const fallbacksFrom: string[] = [];

  // Two passes over the chain with a pause between. Free-pool 429s clear on
  // a timescale of tens of seconds, so a chain that failed end to end at t=0
  // often has a working model at t=30s -- and one pause is far cheaper than
  // discarding the run.
  const passes = options.fallbackModels?.length ? 2 : 1;
  let result: Omit<TaskRunResult, "fallbacksFrom"> | undefined;

  for (let pass = 0; pass < passes; pass++) {
    if (pass > 0) await new Promise((r) => setTimeout(r, 30_000));
    for (const modelId of chain) {
      result = await runTaskOnce({ ...options, modelId });
      const providerFailure = result.error?.startsWith("provider error") === true;
      if (!providerFailure) return { ...result, fallbacksFrom };
      fallbacksFrom.push(modelId);
    }
  }

  if (!result) throw new Error("unreachable: empty model chain");
  return { ...result, fallbacksFrom };
}

async function runTaskOnce(options: TaskRunOptions): Promise<Omit<TaskRunResult, "fallbacksFrom">> {
  const sessionId = randomUUID();
  const started = Date.now();
  const toolCalls: string[] = [];
  const events: TelemetryEvent[] = [];
  const masked = { count: 0, tokensBefore: 0, tokensAfter: 0 };
  const modes = new Set<string>();

  // Compaction thresholds are relative to the model's context window, so the
  // window has to come from the model rather than a constant.
  const windowTokens =
    findModel(options.modelId)?.contextLength ??
    (resolveModel(options.modelId) as { contextWindow?: number }).contextWindow ??
    128_000;

  const extensions: Extension[] = options.history
    ? [
        createHistoryExtension({
          cacheRoot: join(options.cwd, ".agent", "cache"),
          windowTokens,
          sessionId,
          onCompaction: (event) => {
            masked.count += 1;
            masked.tokensBefore += event.tokensBefore;
            masked.tokensAfter += event.tokensAfter;
          },
          onDecision: (decision) => modes.add(decision.mode),
        }) as never,
      ]
    : [];

  // Eval tasks verify by running arbitrary commands, so the harness is the
  // one caller that legitimately runs in yolo. The deny list still applies.
  extensions.push({
    name: "permissions",
    toolGuards: [createPermissionGuard({ mode: "yolo" })],
  });

  const graphQueries = { count: 0, tokens: 0, results: 0 };
  const graph = options.graph ? await buildGraph(options.cwd) : undefined;

  const agent = createAgent({
    modelId: options.modelId,
    apiKey: options.apiKey,
    cwd: options.cwd,
    sessionId,
    extensions,
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    ...(graph
      ? {
          pinnedContext: buildTaskMap({
            store: graph,
            countTokens: countTextTokens,
            prompt: options.prompt,
          }).text,
        }
      : {}),
    ...(graph
      ? {
          graph: {
            store: graph,
            onQuery: (event) => {
              graphQueries.count += 1;
              graphQueries.tokens += event.tokens;
              graphQueries.results += event.results;
            },
          },
        }
      : {}),
  });

  agent.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      toolCalls.push((event as { toolName?: string }).toolName ?? "unknown");
    }
  });

  let error: string | undefined;
  try {
    const timeout = options.timeoutMs ?? 600_000;
    await Promise.race([
      agent.prompt(options.prompt),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`task exceeded ${timeout}ms`)), timeout),
      ),
    ]);
  } catch (thrown) {
    error = (thrown as Error).message;
  }

  // Usage lives on assistant messages; every one is a provider round trip.
  const assistantMessages = agent.state.messages.filter((m) => m.role === "assistant");

  // A provider error ends the turn with stopReason "error" and no exception,
  // so without this check a 402 or a bad model id reports ok:true with zero
  // tokens -- a "success" that solved nothing. SPEC 4.9 names this defect.
  const failed = assistantMessages.find(
    (m) => (m as unknown as { stopReason?: string }).stopReason === "error",
  );
  if (error === undefined && failed) {
    error = `provider error: ${
      (failed as unknown as { errorMessage?: string }).errorMessage?.slice(0, 300) ?? "unknown"
    }`;
  }
  if (error === undefined && assistantMessages.length === 0) {
    error = "model produced no response";
  }
  for (const [index, message] of assistantMessages.entries()) {
    const usage = (message as unknown as { usage?: PiUsage }).usage;
    if (!usage) continue;

    const step: StepEvent = {
      type: "step",
      ts: new Date().toISOString(),
      sessionId,
      stepId: `${sessionId}-${index}`,
      // The baseline harness has no router, so every step is the flash layer.
      layer: "flash",
      model: options.modelId,
      provider: "openrouter",
      tokens: {
        input: usage.input ?? 0,
        cached: usage.cacheRead ?? 0,
        output: usage.output ?? 0,
      },
      costUsd: usage.cost?.total ?? 0,
      latencyMs: 0,
    };
    events.push(step);
  }

  const totals = aggregate(events);

  return {
    ok: error === undefined,
    sessionId,
    turns: assistantMessages.length,
    toolCalls,
    tokens: totals.tokens,
    costUsd: totals.costUsd,
    wallMs: Date.now() - started,
    cacheHitRate: totals.cacheHitRate,
    masked,
    compactionModes: [...modes],
    graphQueries,
    modelId: options.modelId,
    ...(error === undefined ? {} : { error }),
  };
}
