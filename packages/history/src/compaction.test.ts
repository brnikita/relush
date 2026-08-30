import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ContentCache } from "./cache.ts";
import {
  BatchedCompactor,
  breakEvenTokens,
  CACHE_RATE_RATIO,
  carriesFailureSignal,
  ExpandError,
  expand,
  isCompacted,
  type MessageLike,
  parseCompactedPlaceholder,
} from "./compaction.ts";

const cache = () => new ContentCache({ root: mkdtempSync(join(tmpdir(), "nodrel-compact-")) });

/** Rough token proxy; compaction only needs relative sizes. */
const countTokens = (text: string) => Math.ceil(text.length / 4);

const user = (text: string): MessageLike => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string): MessageLike => ({
  role: "assistant",
  content: [{ type: "text", text }],
});
const toolResult = (text: string, extra: Partial<MessageLike> = {}): MessageLike => ({
  role: "toolResult",
  toolCallId: `c-${Math.random()}`,
  toolName: "read",
  content: [{ type: "text", text }],
  ...extra,
});

const textOf = (m: MessageLike): string =>
  ((m.content as { text?: string }[]) ?? []).map((p) => p.text ?? "").join("");

/** A transcript of `turns` turns, each carrying one tool result of `size` chars. */
const transcript = (turns: number, size = 8000): MessageLike[] => {
  const messages: MessageLike[] = [];
  for (let i = 0; i < turns; i++) {
    messages.push(user(`ask ${i}`));
    messages.push(toolResult(`out-${i} ${"x".repeat(size)}`));
    messages.push(assistant(`answer ${i}`));
  }
  return messages;
};

const compactor = (overrides: Partial<ConstructorParameters<typeof BatchedCompactor>[0]> = {}) =>
  new BatchedCompactor({
    cache: cache(),
    countTokens,
    windowTokens: 20_000,
    ...overrides,
  });

describe("breakEvenTokens", () => {
  it("requires 4x the suffix when only one request follows", () => {
    // The v1.0 sliding-window case: R = 1.
    expect(breakEvenTokens(10_000, 1)).toBeCloseTo(10_000 * 4 + 25, 0);
  });

  it("falls proportionally as more requests reuse the batch", () => {
    expect(breakEvenTokens(10_000, 20)).toBeCloseTo((10_000 * 4) / 20 + 25, 0);
  });

  it("is unreachable when no request would reuse the result", () => {
    expect(breakEvenTokens(10_000, 0)).toBe(Number.POSITIVE_INFINITY);
  });

  it("derives from the provider cache ratio, not a magic constant", () => {
    const suffix = 5000;
    const expected = (suffix * (1 - CACHE_RATE_RATIO)) / (CACHE_RATE_RATIO * 10) + 25;

    expect(breakEvenTokens(suffix, 10)).toBeCloseTo(expected, 6);
  });
});

describe("append-only path", () => {
  it("changes nothing below the pressure threshold", () => {
    const messages = transcript(3);
    const decision = compactor().process(messages);

    expect(decision.compacted).toBe(false);
    expect(decision.messages).toEqual(messages);
  });

  it("explains why it declined", () => {
    expect(compactor().process(transcript(2)).reason).toMatch(/below pressure threshold/);
  });

  it("leaves a long transcript alone if the window is large enough", () => {
    // Pressure, not age, is the trigger; v1.0 compacted on age alone.
    const decision = compactor({ windowTokens: 10_000_000 }).process(transcript(40));

    expect(decision.compacted).toBe(false);
  });
});

describe("opportunistic mode", () => {
  it("declines when nothing clears break-even, which is the common case", () => {
    // At R=20 with a large suffix, a 2,000-token output must not be compacted:
    // the cache it costs exceeds what it saves. Measured tool outputs average
    // ~160 tokens, so this is the normal outcome, not an edge case.
    // Window sized so the transcript sits between the pressure threshold and
    // the hard limit: compaction is allowed, but not forced.
    const decision = compactor({ windowTokens: 60_000 }).process(transcript(20));

    expect(decision.mode).toBe("opportunistic");
    expect(decision.compacted).toBe(false);
    expect(decision.reason).toMatch(/break-even/);
  });

  it("compacts an output large enough to pay for its own cache loss", () => {
    // One dominant output early, little after it: a small suffix to invalidate.
    const messages = [
      user("ask"),
      toolResult("huge ".repeat(20_000)),
      assistant("done"),
      ...transcript(7, 200),
    ];

    const decision = compactor({ windowTokens: 40_000 }).process(messages);

    expect(decision.mode).toBe("opportunistic");
    expect(decision.compacted).toBe(true);
  });
});

describe("mandatory mode", () => {
  it("compacts past the hard limit regardless of break-even", () => {
    // Feasibility outranks cost: the alternative is a request that does not fit.
    const decision = compactor().process(transcript(20));

    expect(decision.mode).toBe("mandatory");
    expect(decision.compacted).toBe(true);
    expect(decision.messages.some((m) => isCompacted(textOf(m)))).toBe(true);
  });

  it("stops as soon as the transcript fits again", () => {
    // Every rewrite past that point is pure cache loss for no benefit.
    const decision = compactor().process(transcript(30));
    const compactedCount = decision.messages.filter((m) => isCompacted(textOf(m))).length;
    const candidates = decision.messages.filter((m) => m.role === "toolResult").length;

    expect(compactedCount).toBeGreaterThan(0);
    expect(compactedCount).toBeLessThan(candidates);
  });

  it("spends its single invalidation on the largest outputs first", () => {
    const messages = [
      user("a"),
      toolResult(`small ${"s".repeat(400)}`),
      assistant("x"),
      user("b"),
      toolResult(`large ${"L".repeat(80_000)}`),
      assistant("y"),
      ...transcript(8, 4000),
    ];

    const decision = compactor({ windowTokens: 20_000 }).process(messages);
    const large = decision.messages[4] as MessageLike;
    const small = decision.messages[1] as MessageLike;

    expect(isCompacted(textOf(large))).toBe(true);
    expect(isCompacted(textOf(small))).toBe(false);
  });
});

describe("batched compaction", () => {
  it("replays a frozen region byte-identically on later turns", () => {
    // The property the whole design rests on: after one invalidation the
    // compacted prefix must be stable, or the cache never re-warms and this is
    // just v1.0 with extra steps.
    const compactorInstance = compactor();
    const first = compactorInstance.process(transcript(20));

    const grown = [...first.messages, user("next"), toolResult("small"), assistant("ok")];
    const second = compactorInstance.process(grown);

    for (let i = 0; i < first.messages.length; i++) {
      expect(textOf(second.messages[i] as MessageLike), `message ${i}`).toBe(
        textOf(first.messages[i] as MessageLike),
      );
    }
  });

  it("does not recompact an already-frozen message", () => {
    const compactorInstance = compactor();
    compactorInstance.process(transcript(20));
    const batchesAfterFirst = compactorInstance.batches;

    // Same transcript again: everything compactable is already frozen.
    compactorInstance.process(transcript(20));

    expect(compactorInstance.batches).toBe(batchesAfterFirst);
  });

  it("counts one batch rather than one event per message", () => {
    const compactorInstance = compactor();
    compactorInstance.process(transcript(20));

    // Many messages compacted, but a single cache invalidation.
    expect(compactorInstance.batches).toBe(1);
  });

  it("reduces total tokens", () => {
    const before = transcript(20);
    const after = compactor().process(before).messages;

    const total = (ms: readonly MessageLike[]) =>
      ms.reduce((s, m) => s + countTokens(textOf(m)), 0);

    expect(total(after)).toBeLessThan(total(before));
  });

  it("leaves the recent window untouched", () => {
    const decision = compactor({ keepRecentTurns: 6 }).process(transcript(20));
    const lastToolResult = [...decision.messages].reverse().find((m) => m.role === "toolResult");

    expect(isCompacted(textOf(lastToolResult as MessageLike))).toBe(false);
  });

  it("preserves the tool call and name, hiding only the observation", () => {
    const decision = compactor().process(transcript(20));
    const compacted = decision.messages.find((m) => isCompacted(textOf(m)));

    expect(compacted?.toolName).toBe("read");
    expect(compacted?.toolCallId).toBeTruthy();
  });

  it("never rewrites user or assistant messages", () => {
    const decision = compactor().process(transcript(20));

    for (const message of decision.messages) {
      if (message.role !== "toolResult") expect(isCompacted(textOf(message))).toBe(false);
    }
  });

  it("does not compact images, which a text placeholder cannot represent", () => {
    const messages = [
      ...transcript(20),
      { role: "toolResult", toolName: "read", content: [{ type: "image", data: "..." }] },
      ...transcript(8),
    ];

    const decision = compactor().process(messages);
    const image = decision.messages.find((m) =>
      ((m.content as { type: string }[]) ?? []).some((p) => p.type === "image"),
    );

    const parts = (image?.content ?? []) as { type: string }[];
    expect(parts[0]?.type).toBe("image");
  });

  it("reports each compacted output for telemetry", () => {
    const seen: { tokensBefore: number; tokensAfter: number }[] = [];
    compactor({ onCompact: (e) => seen.push(e) }).process(transcript(20));

    expect(seen.length).toBeGreaterThan(0);
    for (const event of seen) expect(event.tokensAfter).toBeLessThan(event.tokensBefore);
  });
});

describe("failure-signal preservation (SPEC §4.4 rule 5)", () => {
  it.each([
    ["assertion failure", "AssertionError: expected 5 to equal 6"],
    ["python traceback", "Traceback (most recent call last):\n  File x"],
    ["stack frame", "  at Object.<anonymous> (/app/test.js:12:9)"],
    ["failed test count", "3 tests failed"],
    ["npm error", "npm ERR! code ELIFECYCLE"],
    ["non-zero exit", "exited with code 1"],
    ["bare FAIL", "FAIL packages/x/y.test.ts"],
  ])("recognizes %s", (_label, text) => {
    expect(carriesFailureSignal(text)).toBe(true);
  });

  it("does not flag ordinary output", () => {
    expect(carriesFailureSignal("all tests passed, 12 ok")).toBe(false);
  });

  it("keeps a large failing output verbatim under pressure", () => {
    // Hiding this is what makes summarization lengthen trajectories: the model
    // stops seeing the failure and repeats the attempt.
    const failure = `AssertionError: expected 5 to equal 6\n${"stack line\n".repeat(2000)}`;
    const messages = [...transcript(10), toolResult(failure), ...transcript(10)];

    const decision = compactor().process(messages);
    const preserved = decision.messages.find((m) => textOf(m).startsWith("AssertionError"));

    expect(preserved).toBeDefined();
    expect(isCompacted(textOf(preserved as MessageLike))).toBe(false);
  });

  it("keeps output explicitly flagged as an error", () => {
    const messages = [
      ...transcript(10),
      toolResult("x".repeat(40_000), { isError: true }),
      ...transcript(10),
    ];

    const decision = compactor().process(messages);
    const errorResult = decision.messages.find((m) => m.isError === true);

    expect(isCompacted(textOf(errorResult as MessageLike))).toBe(false);
  });
});

describe("expand", () => {
  it("returns the original byte for byte", () => {
    const store = cache();
    const original = `${"line\r\n\ttabbed\n   trailing   \n".repeat(500)}`;
    const instance = new BatchedCompactor({
      cache: store,
      countTokens,
      windowTokens: 20_000,
    });

    const decision = instance.process([...transcript(10), toolResult(original), ...transcript(10)]);
    const ids = decision.messages
      .map((m) => parseCompactedPlaceholder(textOf(m)))
      .filter((id): id is string => id !== undefined);

    expect(ids.map((id) => expand(store, id))).toContain(original);
  });

  it("throws a named error for an unknown id", () => {
    expect(() => expand(cache(), "deadbeef")).toThrow(ExpandError);
  });
});
