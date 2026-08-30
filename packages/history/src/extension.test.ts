import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isCompacted } from "./compaction.ts";
import { createHistoryExtension } from "./extension.ts";

const root = () => mkdtempSync(join(tmpdir(), "nodrel-ext-"));

const msg = (role: string, text: string) => ({
  role,
  content: [{ type: "text", text }],
  ...(role === "toolResult" ? { toolCallId: "c1", toolName: "read" } : {}),
});

const textOf = (m: unknown): string =>
  (((m as { content?: { text?: string }[] }).content ?? []) as { text?: string }[])
    .map((p) => p.text ?? "")
    .join("");

/** A session large enough to exceed a deliberately small window. */
const session = (turns: number, size: number) => {
  const messages: unknown[] = [];
  for (let i = 0; i < turns; i++) {
    messages.push(msg("user", `ask ${i}`));
    messages.push(msg("toolResult", `out-${i} ${"x".repeat(size)}`));
    messages.push(msg("assistant", `answer ${i}`));
  }
  return messages;
};

describe("history extension", () => {
  it("is append-only when the window is roomy", async () => {
    const extension = createHistoryExtension({
      cacheRoot: root(),
      windowTokens: 1_000_000,
    });
    const input = session(20, 4000);

    const output = await extension.historyStages[0]?.transform(input);

    expect(output).toEqual(input);
  });

  it("keeps a session inside a small window, and says which mode it used", async () => {
    // The P2 gate's feasibility claim: under real pressure the session still
    // fits, which is what compaction actually buys.
    const modes: string[] = [];
    const extension = createHistoryExtension({
      cacheRoot: root(),
      windowTokens: 8_000,
      onDecision: (d) => modes.push(d.mode),
    });

    const output = (await extension.historyStages[0]?.transform(session(20, 4000))) ?? [];

    expect(modes).toContain("mandatory");
    expect(output.some((m) => isCompacted(textOf(m)))).toBe(true);
  });

  it("replays identical bytes across turns, so the cache re-warms", async () => {
    const extension = createHistoryExtension({ cacheRoot: root(), windowTokens: 8_000 });
    const stage = extension.historyStages[0];

    const first = (await stage?.transform(session(20, 4000))) ?? [];
    const grown = [...first, msg("user", "next"), msg("assistant", "ok")];
    const second = (await stage?.transform(grown)) ?? [];

    for (let i = 0; i < first.length; i++) {
      expect(textOf(second[i]), `message ${i}`).toBe(textOf(first[i]));
    }
  });

  it("reports compaction events for telemetry", async () => {
    const events: { tokensBefore: number; tokensAfter: number }[] = [];
    const extension = createHistoryExtension({
      cacheRoot: root(),
      windowTokens: 8_000,
      onCompaction: (e) => events.push(e),
    });

    await extension.historyStages[0]?.transform(session(20, 4000));

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(event.tokensAfter).toBeLessThan(event.tokensBefore);
  });

  it("preserves a failing test's output even under mandatory pressure", async () => {
    const failure = `AssertionError: expected 5 to equal 6\n${"stack\n".repeat(3000)}`;
    const extension = createHistoryExtension({ cacheRoot: root(), windowTokens: 8_000 });

    const input = [...session(10, 4000), msg("toolResult", failure), ...session(10, 4000)];
    const output = (await extension.historyStages[0]?.transform(input)) ?? [];

    const preserved = output.find((m) => textOf(m).startsWith("AssertionError"));
    expect(preserved).toBeDefined();
    expect(isCompacted(textOf(preserved))).toBe(false);
  });
});
