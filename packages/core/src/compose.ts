import type {
  AfterToolCallContext,
  AfterToolCallResult,
  AgentLoopTurnUpdate,
  AgentMessage,
  BeforeToolCallContext,
  BeforeToolCallResult,
  PrepareNextTurnContext,
} from "@earendil-works/pi-agent-core";
import type { Extension, HistoryStage, ToolGuard, TurnPlanner } from "./extensions.ts";

/**
 * The subset of Pi's `AgentOptions` that nodrel composes. Kept structural
 * rather than importing `AgentOptions` directly so a change to unrelated Pi
 * options cannot break this signature.
 */
export interface ComposedHooks {
  transformContext(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]>;
  afterToolCall(
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ): Promise<AfterToolCallResult | undefined>;
  beforeToolCall(
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ): Promise<BeforeToolCallResult | undefined>;
  prepareNextTurnWithContext(
    context: PrepareNextTurnContext,
    signal?: AbortSignal,
  ): Promise<AgentLoopTurnUpdate | undefined>;
}

/** Flattens `extensions[].field` into one ordered list. */
const collect = <T>(
  extensions: readonly Extension[],
  pick: (e: Extension) => readonly T[] | undefined,
): T[] => extensions.flatMap((e) => [...(pick(e) ?? [])]);

/**
 * Composes extensions into a single set of Pi hooks.
 *
 * Composition rules differ per hook because the hooks mean different things:
 *
 * - **History stages pipe.** Each receives the previous stage's output, so
 *   order is part of the contract (mask, then compress, then pin).
 * - **Tool-result stages pipe too**, but each sees the accumulated override
 *   merged over the original context, so a later stage compresses what an
 *   earlier one produced rather than the raw output.
 * - **Guards short-circuit.** The first blocking verdict wins; a guard that
 *   returns nothing abstains.
 * - **Planners are last-wins.** An explicit user pin registers after the
 *   automatic router and therefore overrides it.
 */
export function composeHooks(extensions: readonly Extension[]): ComposedHooks {
  const historyStages = collect<HistoryStage>(extensions, (e) => e.historyStages);
  const toolResultStages = collect(extensions, (e) => e.toolResultStages);
  const toolGuards = collect<ToolGuard>(extensions, (e) => e.toolGuards);
  const turnPlanners = collect<TurnPlanner>(extensions, (e) => e.turnPlanners);

  return {
    async transformContext(messages, signal) {
      let current = messages;
      for (const stage of historyStages) {
        current = await stage.transform(current, signal);
      }
      return current;
    },

    async afterToolCall(context, signal) {
      let merged: AfterToolCallResult | undefined;
      for (const stage of toolResultStages) {
        // Each stage sees the result of the previous one, not the raw output.
        const view = merged ? { ...context, ...merged } : context;
        const next = await stage.process(view as AfterToolCallContext, signal);
        if (next) merged = { ...merged, ...next };
      }
      return merged;
    },

    async beforeToolCall(context, signal) {
      for (const guard of toolGuards) {
        const verdict = await guard.check(context, signal);
        if (verdict?.block) return verdict;
      }
      return undefined;
    },

    async prepareNextTurnWithContext(context, signal) {
      let update: AgentLoopTurnUpdate | undefined;
      for (const planner of turnPlanners) {
        const next = await planner.plan(context, signal);
        if (next) update = { ...update, ...next };
      }
      return update;
    },
  };
}
