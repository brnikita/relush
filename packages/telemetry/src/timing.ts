/**
 * Per-turn latency breakdown (ROADMAP item 2).
 *
 * nodrel measured 2.2× slower per task than an expensive model, and the data
 * could not say whether that is the provider's time-to-first-token, the number
 * of turns, or tool execution. This splits a turn into the three, so the next
 * measurement can.
 *
 * Fed from the agent's lifecycle events. It is deliberately a pure state
 * machine over `(type, timestamp)` pairs, so it can be tested without an agent
 * and attached to any event stream that emits the same names.
 */

export interface TurnTiming {
  readonly turn: number;
  /** Turn start → first `message_update` carrying content. */
  readonly ttftMs: number;
  /** Turn start → `message_end`: the whole provider round trip. */
  readonly providerMs: number;
  /** Sum of `tool_execution_start` → `tool_execution_end` within the turn. */
  readonly toolMs: number;
  readonly toolCalls: number;
}

export interface TimingSummary {
  readonly turns: number;
  readonly totalMs: number;
  readonly providerMs: number;
  readonly toolMs: number;
  /** Time not attributable to provider or tools: harness overhead. */
  readonly harnessMs: number;
  readonly meanTtftMs: number;
  readonly meanProviderMs: number;
  readonly perTurn: readonly TurnTiming[];
}

type EventName =
  | "turn_start"
  | "turn_end"
  | "message_start"
  | "message_update"
  | "message_end"
  | "tool_execution_start"
  | "tool_execution_end";

export class TurnTimer {
  private readonly turns: TurnTiming[] = [];
  private turnStart: number | undefined;
  private firstToken: number | undefined;
  private messageEnd: number | undefined;
  private toolStart: number | undefined;
  private toolMs = 0;
  private toolCalls = 0;
  private sessionStart: number | undefined;
  private sessionEnd: number | undefined;

  /** Records one event. `at` is a millisecond timestamp. */
  record(type: EventName | string, at: number): void {
    this.sessionStart ??= at;
    this.sessionEnd = at;

    switch (type) {
      case "turn_start":
        this.turnStart = at;
        this.firstToken = undefined;
        this.messageEnd = undefined;
        this.toolMs = 0;
        this.toolCalls = 0;
        return;

      case "message_update":
        // First content delta of the turn is time-to-first-token.
        this.firstToken ??= at;
        return;

      case "message_end":
        this.messageEnd = at;
        return;

      case "tool_execution_start":
        this.toolStart = at;
        this.toolCalls += 1;
        return;

      case "tool_execution_end":
        if (this.toolStart !== undefined) this.toolMs += at - this.toolStart;
        this.toolStart = undefined;
        return;

      case "turn_end": {
        if (this.turnStart === undefined) return;
        this.turns.push({
          turn: this.turns.length + 1,
          ttftMs: (this.firstToken ?? this.messageEnd ?? at) - this.turnStart,
          providerMs: (this.messageEnd ?? at) - this.turnStart,
          toolMs: this.toolMs,
          toolCalls: this.toolCalls,
        });
        this.turnStart = undefined;
        return;
      }

      default:
        return;
    }
  }

  summary(): TimingSummary {
    const providerMs = this.turns.reduce((s, t) => s + t.providerMs, 0);
    const toolMs = this.turns.reduce((s, t) => s + t.toolMs, 0);
    const totalMs =
      this.sessionStart === undefined || this.sessionEnd === undefined
        ? 0
        : this.sessionEnd - this.sessionStart;
    const n = this.turns.length;

    return {
      turns: n,
      totalMs,
      providerMs,
      toolMs,
      harnessMs: Math.max(0, totalMs - providerMs - toolMs),
      meanTtftMs: n === 0 ? 0 : this.turns.reduce((s, t) => s + t.ttftMs, 0) / n,
      meanProviderMs: n === 0 ? 0 : providerMs / n,
      perTurn: this.turns,
    };
  }
}
