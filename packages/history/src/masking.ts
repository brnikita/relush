import type { ContentCache, ContentId } from "./cache.ts";

/**
 * Observation masking (SPEC §4.4) — the default history strategy.
 *
 * Tool outputs older than `keepRecentTurns` are replaced with a placeholder
 * naming their size and content id. The tool call and its arguments stay
 * verbatim, so the model still knows what it did and why; only the bulky
 * observation is elided, and `expand(id)` brings it back.
 *
 * This is the default rather than summarization on purpose. Per SPEC §1.1,
 * masking matches LLM-summarization quality at zero extra compute, while
 * summaries lengthen trajectories 13–15% by hiding failure signals. Masking
 * hides nothing: it defers.
 */

/** Default from SPEC §4.4. */
export const DEFAULT_KEEP_RECENT_TURNS = 6;

/** Minimum tokens an output must cost before masking is worth it. */
export const DEFAULT_MIN_TOKENS_TO_MASK = 50;

/** Shape of the messages this stage rewrites. Structural, to avoid coupling. */
interface TextPart {
  type: string;
  text?: string;
}

interface MessageLike {
  role: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
}

export interface MaskingOptions {
  readonly cache: ContentCache;
  /** Tool results within this many turns of the end are left untouched. */
  readonly keepRecentTurns?: number;
  /** Outputs smaller than this are not worth a placeholder. */
  readonly minTokensToMask?: number;
  readonly countTokens: (text: string) => number;
  /** Notified for each masked output, for the compaction telemetry event. */
  readonly onMask?: (event: { id: ContentId; tokensBefore: number; tokensAfter: number }) => void;
}

const isToolResult = (message: MessageLike): boolean => message.role === "toolResult";

/** An assistant message marks the boundary of a turn. */
const isTurnBoundary = (message: MessageLike): boolean => message.role === "assistant";

export const maskPlaceholder = (tokens: number, id: ContentId): string =>
  `[output masked: ${tokens.toLocaleString("en-US")} tokens, sha=${id}. Call expand("${id}") to retrieve it.]`;

/** Recovers the content id from a placeholder, or `undefined`. */
export const parseMaskPlaceholder = (text: string): ContentId | undefined =>
  /^\[output masked: [\d,]+ tokens, sha=([0-9a-f]+)\./.exec(text)?.[1];

export const isMasked = (text: string): boolean => parseMaskPlaceholder(text) !== undefined;

const textOf = (content: unknown): string | undefined => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;

  const parts = content as TextPart[];
  // Images have no text and must not be replaced by a text placeholder; a
  // masked image would be unrecoverable in the transcript's own terms.
  if (parts.some((p) => p.type !== "text")) return undefined;
  return parts.map((p) => p.text ?? "").join("");
};

/**
 * Masks tool outputs older than the recent window.
 *
 * Turns are counted backwards from the end, so the window follows the
 * conversation rather than being anchored to its start.
 */
export function maskOldOutputs(
  messages: readonly MessageLike[],
  options: MaskingOptions,
): MessageLike[] {
  const keep = options.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS;
  const minTokens = options.minTokensToMask ?? DEFAULT_MIN_TOKENS_TO_MASK;

  // Index of the first message inside the protected recent window.
  let boundary = messages.length;
  let turns = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message && isTurnBoundary(message)) {
      turns += 1;
      if (turns > keep) break;
    }
    boundary = i;
  }

  return messages.map((message, index) => {
    if (index >= boundary || !isToolResult(message)) return message;

    const text = textOf(message.content);
    if (text === undefined || isMasked(text)) return message;

    const tokensBefore = options.countTokens(text);
    // Below the threshold a placeholder can cost more than the output it
    // replaces, which would make masking a regression.
    if (tokensBefore < minTokens) return message;

    const id = options.cache.put(text);
    const placeholder = maskPlaceholder(tokensBefore, id);
    const tokensAfter = options.countTokens(placeholder);

    if (tokensAfter >= tokensBefore) return message;

    options.onMask?.({ id, tokensBefore, tokensAfter });

    return {
      ...message,
      content: [{ type: "text", text: placeholder }],
    };
  });
}

export class ExpandError extends Error {
  constructor(id: string) {
    super(`no cached content for id ${id}`);
    this.name = "ExpandError";
  }
}

/** Retrieves masked content by id. Throws if the id is unknown. */
export function expand(cache: ContentCache, id: ContentId): string {
  const content = cache.getText(id);
  if (content === undefined) throw new ExpandError(id);
  return content;
}
