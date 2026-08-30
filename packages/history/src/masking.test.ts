import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ContentCache } from "./cache.ts";
import { ExpandError, expand, isMasked, maskOldOutputs, parseMaskPlaceholder } from "./masking.ts";

const cache = () => new ContentCache({ root: mkdtempSync(join(tmpdir(), "nodrel-mask-")) });

/** Rough token proxy; masking only needs relative sizes. */
const countTokens = (text: string) => Math.ceil(text.length / 4);

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const toolResult = (text: string, toolName = "read") => ({
  role: "toolResult",
  toolCallId: `c-${Math.random()}`,
  toolName,
  content: [{ type: "text", text }],
});

const big = (label: string) => `${label} `.repeat(400);

const textOf = (m: { content?: unknown }): string =>
  ((m.content as { text?: string }[]) ?? []).map((p) => p.text ?? "").join("");

/** Builds a transcript of `turns` turns, each with one large tool result. */
const transcript = (turns: number) => {
  const messages: ReturnType<typeof user>[] = [];
  for (let i = 0; i < turns; i++) {
    messages.push(user(`ask ${i}`) as never);
    messages.push(toolResult(big(`output-${i}`)) as never);
    messages.push(assistant(`answer ${i}`) as never);
  }
  return messages;
};

describe("mask placeholders", () => {
  it("round-trips the content id", () => {
    const store = cache();
    const messages = maskOldOutputs(transcript(10), { cache: store, countTokens });
    const masked = messages.find((m) => m.role === "toolResult" && isMasked(textOf(m)));

    const id = parseMaskPlaceholder(textOf(masked as never));
    expect(id).toBeTruthy();
    expect(expand(store, id as string)).toContain("output-0");
  });

  it("does not mistake ordinary text for a placeholder", () => {
    expect(isMasked("output masked: something")).toBe(false);
    expect(isMasked("[output masked: not a number tokens, sha=zz.]")).toBe(false);
  });
});

describe("maskOldOutputs", () => {
  it("leaves a short conversation entirely alone", () => {
    const messages = transcript(3);

    expect(maskOldOutputs(messages, { cache: cache(), countTokens })).toEqual(messages);
  });

  it("masks outputs older than the recent window", () => {
    const messages = maskOldOutputs(transcript(12), { cache: cache(), countTokens });
    const masked = messages.filter((m) => m.role === "toolResult" && isMasked(textOf(m)));

    expect(masked.length).toBeGreaterThan(0);
  });

  it("keeps the most recent turns untouched, so current work stays visible", () => {
    const messages = maskOldOutputs(transcript(12), {
      cache: cache(),
      countTokens,
      keepRecentTurns: 6,
    });

    // The final tool result belongs to the newest turn and must be intact.
    const lastToolResult = [...messages].reverse().find((m) => m.role === "toolResult");
    expect(isMasked(textOf(lastToolResult as never))).toBe(false);
  });

  it("preserves the tool call and name, hiding only the observation", () => {
    // The model must still know what it did; SPEC §4.4 masks output, not intent.
    const messages = maskOldOutputs(transcript(12), { cache: cache(), countTokens });
    const masked = messages.find((m) => m.role === "toolResult" && isMasked(textOf(m)));

    expect((masked as { toolName?: string }).toolName).toBe("read");
    expect((masked as { toolCallId?: string }).toolCallId).toBeTruthy();
  });

  it("never masks user or assistant messages", () => {
    const messages = maskOldOutputs(transcript(12), { cache: cache(), countTokens });

    for (const message of messages) {
      if (message.role !== "toolResult") expect(isMasked(textOf(message))).toBe(false);
    }
  });

  it("reduces total tokens", () => {
    const before = transcript(12);
    const after = maskOldOutputs(before, { cache: cache(), countTokens });

    const total = (ms: typeof before) => ms.reduce((s, m) => s + countTokens(textOf(m)), 0);
    expect(total(after as typeof before)).toBeLessThan(total(before));
  });

  it("leaves small outputs alone, since a placeholder can cost more", () => {
    const messages = transcript(12).map((m) =>
      m.role === "toolResult" ? (toolResult("ok") as never) : m,
    );

    const after = maskOldOutputs(messages, { cache: cache(), countTokens });
    expect(after.filter((m) => isMasked(textOf(m)))).toHaveLength(0);
  });

  it("is idempotent, so repeated turns do not re-mask a placeholder", () => {
    const store = cache();
    const once = maskOldOutputs(transcript(12), { cache: store, countTokens });
    const twice = maskOldOutputs(once, { cache: store, countTokens });

    expect(twice).toEqual(once);
  });

  it("does not mask image results, which a text placeholder cannot represent", () => {
    const messages = [
      ...transcript(12),
      { role: "toolResult", toolName: "read", content: [{ type: "image", data: "..." }] },
      ...transcript(8),
    ];

    const after = maskOldOutputs(messages as never, { cache: cache(), countTokens });
    const image = after.find((m) =>
      ((m.content as { type: string }[]) ?? []).some((p) => p.type === "image"),
    );

    expect(image).toBeDefined();
    const parts = (image?.content ?? []) as { type: string }[];
    expect(parts[0]?.type).toBe("image");
  });

  it("reports each masked output for telemetry", () => {
    const seen: { tokensBefore: number; tokensAfter: number }[] = [];

    maskOldOutputs(transcript(12), {
      cache: cache(),
      countTokens,
      onMask: (event) => seen.push(event),
    });

    expect(seen.length).toBeGreaterThan(0);
    for (const event of seen) expect(event.tokensAfter).toBeLessThan(event.tokensBefore);
  });
});

describe("expand", () => {
  it("returns the original content byte for byte", () => {
    const store = cache();
    // Large enough to be worth masking, and full of the whitespace and line
    // endings a lossy round trip would quietly normalize.
    const original = `${"line one\r\n\ttabbed\n   trailing   \n".repeat(50)}`;
    const messages = maskOldOutputs(
      [...transcript(11), toolResult(original) as never, ...transcript(8)],
      { cache: store, countTokens },
    );

    const ids = messages
      .filter((m) => m.role === "toolResult")
      .map((m) => parseMaskPlaceholder(textOf(m)))
      .filter((id): id is string => id !== undefined);

    expect(ids.map((id) => expand(store, id))).toContain(original);
  });

  it("throws a named error for an unknown id", () => {
    expect(() => expand(cache(), "deadbeef")).toThrow(ExpandError);
  });
});
