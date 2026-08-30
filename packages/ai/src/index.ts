/**
 * LLM provider layer (SPEC §4.8): OpenRouter provider, gateway client, cost
 * tables and tokenizers. Local models register here as an OpenAI-compatible
 * provider with `cost: 0`.
 */
export const PACKAGE = "ai" as const;
