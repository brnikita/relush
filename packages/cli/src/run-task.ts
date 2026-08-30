import { randomUUID } from "node:crypto";
import { createAgent } from "@nodrel/core";
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
  readonly error?: string;
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
export async function runTask(options: TaskRunOptions): Promise<TaskRunResult> {
  const sessionId = randomUUID();
  const started = Date.now();
  const toolCalls: string[] = [];
  const events: TelemetryEvent[] = [];

  const agent = createAgent({
    modelId: options.modelId,
    apiKey: options.apiKey,
    cwd: options.cwd,
    sessionId,
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
    ...(error === undefined ? {} : { error }),
  };
}
