import type { Layer, TokenUsage } from "@nodrel/telemetry";

/**
 * nodrel's model registry (SPEC §4.5, §7 M0).
 *
 * Prices are **per token**, matching `pi-ai`'s `ModelCostRates`, so
 * `calculateCost` from that package can be reused rather than reimplemented.
 * Values were read from the OpenRouter catalogue on 2026-08-30 and are pinned
 * here so a silent upstream price change cannot quietly invalidate a committed
 * eval report. `refreshPrices` re-reads them deliberately.
 */

export interface ModelSpec {
  readonly id: string;
  readonly layer: Layer;
  readonly contextLength: number;
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  };
  /** Free models sit in a shared upstream pool and 429 unpredictably. */
  readonly free: boolean;
}

const perToken = (input: number, output: number, cacheRead = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
});

/**
 * The default cloud model (SPEC §7 M0).
 *
 * Note the cache-read rate is 5× cheaper than fresh input ($0.015 vs $0.075
 * per million). That ratio is the entire economic argument for prefix pinning
 * (SPEC §4.4) — at a 75% cache-hit rate it cuts input cost by ~60%.
 */
export const FLASH: ModelSpec = {
  id: "z-ai/glm-5.3-flash",
  layer: "flash",
  contextLength: 1_310_720,
  cost: perToken(0.000_000_075, 0.000_000_25, 0.000_000_015),
  free: false,
};

/** Escalation target (SPEC §4.5). */
export const ESCALATION: ModelSpec = {
  id: "z-ai/glm-5.3",
  layer: "escalation",
  contextLength: 1_310_720,
  cost: perToken(0.000_001_4, 0.000_004_4, 0.000_000_26),
  free: false,
};

/** Reserve escalation (SPEC §4.5). License review required before default use. */
export const RESERVE_ESCALATION: ModelSpec = {
  id: "moonshotai/kimi-k3",
  layer: "escalation",
  contextLength: 1_048_576,
  cost: perToken(0.000_003, 0.000_015, 0.000_000_3),
  free: false,
};

/**
 * Free models for live smoke tests, in fallback order.
 *
 * Ordered by observed reliability, not by benchmark strength.
 * `z-ai/glm-5.2:free` is deliberately absent despite being the strongest free
 * model on paper: it returned `upstream_429` from the shared pool on the first
 * call during F0, while all three below returned correct tool calls.
 */
export const FREE_CHAIN: readonly ModelSpec[] = [
  {
    id: "cohere/north-mini-code:free",
    layer: "flash",
    contextLength: 256_000,
    cost: perToken(0, 0),
    free: true,
  },
  {
    id: "minimax/minimax-m3:free",
    layer: "flash",
    contextLength: 1_048_576,
    cost: perToken(0, 0),
    free: true,
  },
  {
    id: "nvidia/nemotron-3-super-120b-a12b:free",
    layer: "flash",
    contextLength: 262_144,
    cost: perToken(0, 0),
    free: true,
  },
] as const;

export const ALL_MODELS: readonly ModelSpec[] = [
  FLASH,
  ESCALATION,
  RESERVE_ESCALATION,
  ...FREE_CHAIN,
] as const;

export const findModel = (id: string): ModelSpec | undefined => ALL_MODELS.find((m) => m.id === id);

/**
 * Cost in USD for one step.
 *
 * Cached input is billed at the cache-read rate rather than the input rate;
 * charging both at `input` would overstate cost and hide the benefit prefix
 * pinning is supposed to deliver.
 */
export function costOf(model: ModelSpec, tokens: TokenUsage): number {
  return (
    tokens.input * model.cost.input +
    tokens.cached * model.cost.cacheRead +
    tokens.output * model.cost.output
  );
}

/** Blended cost per million tokens, the unit SPEC §1 states targets in. */
export function blendedCostPerMillion(model: ModelSpec, tokens: TokenUsage): number {
  const total = tokens.input + tokens.cached + tokens.output;
  return total === 0 ? 0 : (costOf(model, tokens) / total) * 1_000_000;
}
