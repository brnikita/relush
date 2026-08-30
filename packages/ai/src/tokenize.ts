import { countTokens } from "gpt-tokenizer";

/**
 * Pre-flight token counting (SPEC §4.1).
 *
 * The budget check has to know a request's size *before* sending it, so
 * provider-reported usage is not available and a local estimate is required.
 *
 * ## Why a GPT tokenizer for GLM
 *
 * GLM does not publish a JS tokenizer. Calibrating `gpt-tokenizer` against live
 * `z-ai/glm-5.3-flash` usage showed the difference is not a tokenization ratio
 * at all — it is fixed chat-template overhead:
 *
 * | content tokens (local) | provider `prompt_tokens` | delta |
 * | ---------------------- | ------------------------ | ----- |
 * | 2                      | 14                       | 12    |
 * | 12                     | 23                       | 11    |
 * | 53                     | 66                       | 13    |
 * | 401                    | 413                      | 12    |
 * | 425                    | 436                      | 11    |
 *
 * The delta stays flat while content grows 200×, so the content tokenization
 * itself tracks GLM closely; only the envelope is unaccounted for. A second
 * pass varying message count separated the envelope into a per-request part
 * and a per-message part.
 *
 * Estimates round **up**. For a budget check, overestimating is the safe
 * direction: it can refuse a request that would have just fit, but it can
 * never let one through that would breach SPEC §4.1.
 */

/** Fixed per-request template overhead, empirically fitted. */
export const REQUEST_OVERHEAD_TOKENS = 11;

/** Per-message role/delimiter overhead, empirically fitted (≈1.33, rounded up). */
export const MESSAGE_OVERHEAD_TOKENS = 1.5;

/** A message as counted for budgeting. Only the text matters here. */
export interface CountableMessage {
  readonly role: string;
  readonly content: string;
}

/** Counts tokens in a bare string, with no chat-template envelope. */
export const countTextTokens = (text: string): number => countTokens(text);

/**
 * Estimates the `prompt_tokens` a provider will report for these messages.
 *
 * Accurate to well under 2% on realistic prompts; the fixed envelope dominates
 * only for trivially short ones, where the absolute error is a token or two.
 */
export function estimatePromptTokens(messages: readonly CountableMessage[]): number {
  const content = messages.reduce((sum, m) => sum + countTextTokens(m.content), 0);
  const envelope = REQUEST_OVERHEAD_TOKENS + MESSAGE_OVERHEAD_TOKENS * messages.length;
  return Math.ceil(content + envelope);
}

/**
 * Estimates tokens for a tool definition as the provider will serialize it.
 *
 * Tool schemas count against the fixed overhead in SPEC §4.1, and they are
 * JSON-serialized into the request, so the JSON form is what to measure — not
 * the description prose alone.
 */
export function estimateToolTokens(tool: unknown): number {
  return countTextTokens(JSON.stringify(tool));
}
