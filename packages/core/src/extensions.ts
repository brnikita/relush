import type {
  AfterToolCallContext,
  AfterToolCallResult,
  AgentLoopTurnUpdate,
  AgentMessage,
  BeforeToolCallContext,
  BeforeToolCallResult,
  PrepareNextTurnContext,
} from "@earendil-works/pi-agent-core";

/**
 * The extension points nodrel's packages attach to.
 *
 * Every one of these maps onto a documented hook in `AgentOptions`, which is
 * what makes the depend-and-extend approach viable: the history manager, the
 * context engine and the router all attach here rather than modifying Pi's
 * agent loop.
 *
 * | nodrel package | extension        | Pi hook                      |
 * | -------------- | ---------------- | ---------------------------- |
 * | `history`      | `HistoryStage`   | `transformContext`           |
 * | `history`      | `ToolResultStage`| `afterToolCall`              |
 * | `context`      | `ToolGuard`      | `beforeToolCall`             |
 * | `router`       | `TurnPlanner`    | `prepareNextTurnWithContext` |
 */

/**
 * Rewrites the message history before each provider request.
 *
 * This is where observation masking (SPEC §4.4), compression and prefix pinning
 * live. Stages run in registration order, each receiving the previous stage's
 * output, so ordering is significant: masking must run before the prefix is
 * pinned, or the pinned bytes shift and the provider cache misses.
 */
export interface HistoryStage {
  readonly name: string;
  transform(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]>;
}

/**
 * Rewrites a tool result before it enters the transcript.
 *
 * Compressing here rather than in `transformContext` means the expensive
 * original never enters history in the first place. Returning `undefined`
 * leaves the result untouched.
 */
export interface ToolResultStage {
  readonly name: string;
  process(
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ): Promise<AfterToolCallResult | undefined>;
}

/**
 * Inspects a tool call before it executes, and may block it.
 *
 * The first guard to return a blocking result wins; later guards are not
 * consulted.
 */
export interface ToolGuard {
  readonly name: string;
  check(
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ): Promise<BeforeToolCallResult | undefined>;
}

/**
 * Chooses the model and context for the next turn.
 *
 * This is the router's attachment point (SPEC §4.5). `AgentLoopTurnUpdate`
 * carries an optional `model`, which is what makes per-step layer selection —
 * local, flash, escalation — possible without owning the loop.
 *
 * The last planner to return a value wins, so a user's explicit `/strong` pin
 * is registered after the automatic router and overrides it.
 */
export interface TurnPlanner {
  readonly name: string;
  plan(
    context: PrepareNextTurnContext,
    signal?: AbortSignal,
  ): Promise<AgentLoopTurnUpdate | undefined>;
}

/** Everything a nodrel package can contribute to the agent. */
export interface Extension {
  readonly name: string;
  readonly historyStages?: readonly HistoryStage[];
  readonly toolResultStages?: readonly ToolResultStage[];
  readonly toolGuards?: readonly ToolGuard[];
  readonly turnPlanners?: readonly TurnPlanner[];
}
