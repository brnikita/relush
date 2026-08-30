/**
 * LLM provider layer (SPEC §4.8): OpenRouter provider, gateway client, cost
 * tables and tokenizers. Local models register here as an OpenAI-compatible
 * provider with `cost: 0`.
 */
export type { ModelSpec } from "./models.ts";
export {
  ALL_MODELS,
  blendedCostPerMillion,
  costOf,
  ESCALATION,
  FLASH,
  FREE_CHAIN,
  findModel,
  RESERVE_ESCALATION,
} from "./models.ts";
export type { CountableMessage } from "./tokenize.ts";
export {
  countTextTokens,
  estimatePromptTokens,
  estimateToolTokens,
  MESSAGE_OVERHEAD_TOKENS,
  REQUEST_OVERHEAD_TOKENS,
} from "./tokenize.ts";

export const PACKAGE = "ai" as const;
