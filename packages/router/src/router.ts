import type { Layer, LayerSwitchEvent, TokenUsage } from "@nodrel/telemetry";
import { type ClassifyInput, classify } from "./classifier.ts";

/**
 * Layer routing with failure-driven escalation (SPEC §4.5).
 *
 * The router is stateful across a session because the interesting signal is
 * historical: two consecutive failed verifications mean the current layer is
 * not solving this problem, whatever the prompt looked like when it started.
 */

/** SPEC §4.5: escalate after this many consecutive failures. */
export const FAILURES_TO_ESCALATE = 2;

/** SPEC §4.5: de-escalate after this many consecutive green steps. */
export const GREENS_TO_DE_ESCALATE = 2;

/** SPEC §4.5, CI-tested invariant. */
export const ESCALATION_TOKEN_LIMIT = 0.15;

export type LayerPin = Layer | "auto";

export interface RouteDecision {
  readonly layer: Layer;
  readonly reason: string;
  /** Set when this decision changed layers. */
  readonly switched?: { from: Layer; to: Layer };
}

export interface RouterOptions {
  readonly localAvailable?: boolean;
  /** Notified on every layer change, for telemetry and the TUI badge. */
  readonly onSwitch?: (event: Omit<LayerSwitchEvent, "ts" | "sessionId" | "type">) => void;
}

export class Router {
  private pin: LayerPin = "auto";
  private consecutiveFailures = 0;
  private consecutiveGreens = 0;
  private escalated = false;
  private current: Layer = "flash";
  private readonly options: RouterOptions;
  private readonly tokensByLayer = new Map<Layer, number>();

  constructor(options: RouterOptions = {}) {
    this.options = options;
  }

  /** `/model`, `/fast`, `/strong`. `auto` returns control to the router. */
  setPin(pin: LayerPin): void {
    this.pin = pin;
  }

  get pinned(): LayerPin {
    return this.pin;
  }

  get layer(): Layer {
    return this.current;
  }

  /** Chooses the layer for the next step. */
  route(input: ClassifyInput): RouteDecision {
    const previous = this.current;

    if (this.pin !== "auto") {
      this.current = this.pin;
      return this.decide(previous, `pinned to ${this.pin}`);
    }

    // A failure streak outranks classification: the prompt has not changed, but
    // the evidence that the current layer can handle it has.
    if (this.escalated) {
      this.current = "escalation";
      return this.decide(
        previous,
        `escalated after ${FAILURES_TO_ESCALATE} consecutive failed verifications`,
      );
    }

    const classification = classify({
      ...input,
      ...(this.options.localAvailable === undefined
        ? {}
        : { localAvailable: this.options.localAvailable }),
    });
    this.current = classification.layer;
    return this.decide(previous, classification.reason);
  }

  private decide(previous: Layer, reason: string): RouteDecision {
    if (previous === this.current) return { layer: this.current, reason };

    const switched = { from: previous, to: this.current };
    this.options.onSwitch?.({ ...switched, reason });
    return { layer: this.current, reason, switched };
  }

  /**
   * Records a step's verification outcome.
   *
   * De-escalation needs consecutive greens rather than a single one: one
   * passing step after an escalation often means the strong model just fixed
   * it, not that the cheap model can now cope.
   */
  recordResult(passed: boolean): void {
    if (passed) {
      this.consecutiveFailures = 0;
      this.consecutiveGreens += 1;
      if (this.escalated && this.consecutiveGreens >= GREENS_TO_DE_ESCALATE) {
        this.escalated = false;
        this.consecutiveGreens = 0;
      }
      return;
    }

    this.consecutiveGreens = 0;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= FAILURES_TO_ESCALATE) this.escalated = true;
  }

  /** Accumulates usage per layer, for the escalation-share invariant. */
  recordUsage(layer: Layer, tokens: TokenUsage): void {
    const total = tokens.input + tokens.cached + tokens.output;
    this.tokensByLayer.set(layer, (this.tokensByLayer.get(layer) ?? 0) + total);
  }

  /** Share of tokens spent on escalation, in `[0, 1]`. */
  get escalationShare(): number {
    let total = 0;
    for (const value of this.tokensByLayer.values()) total += value;
    return total === 0 ? 0 : (this.tokensByLayer.get("escalation") ?? 0) / total;
  }

  /** Share of tokens that ran locally and therefore cost nothing. */
  get localShare(): number {
    let total = 0;
    for (const value of this.tokensByLayer.values()) total += value;
    return total === 0 ? 0 : (this.tokensByLayer.get("local") ?? 0) / total;
  }

  /** Whether the session is inside SPEC §4.5's hard invariant. */
  get withinEscalationLimit(): boolean {
    return this.escalationShare <= ESCALATION_TOKEN_LIMIT;
  }

  /** Diagnostic snapshot, for `/cost` and the TUI. */
  snapshot(): {
    layer: Layer;
    pinned: LayerPin;
    escalated: boolean;
    consecutiveFailures: number;
    escalationShare: number;
    localShare: number;
  } {
    return {
      layer: this.current,
      pinned: this.pin,
      escalated: this.escalated,
      consecutiveFailures: this.consecutiveFailures,
      escalationShare: this.escalationShare,
      localShare: this.localShare,
    };
  }
}
