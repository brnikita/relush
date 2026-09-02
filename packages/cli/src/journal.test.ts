import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Journal } from "./journal.ts";

const path = () => join(mkdtempSync(join(tmpdir(), "nodrel-journal-")), "conversation.jsonl");

describe("Journal", () => {
  it("round-trips messages in order", () => {
    const p = path();
    const j = new Journal(p);
    j.append({ role: "user", text: "a" });
    j.append({ role: "assistant", text: "b" });

    const { messages, torn } = Journal.resume(p);
    expect(messages).toEqual([
      { role: "user", text: "a" },
      { role: "assistant", text: "b" },
    ]);
    expect(torn).toBe(0);
  });

  it("survives a torn trailing line from a crash mid-write", () => {
    // kill -9 during appendFileSync leaves a partial last record.
    const p = path();
    const j = new Journal(p);
    j.append({ role: "user", text: "complete" });
    writeFileSync(p, `${readFileSync(p, "utf8")}{"seq":2,"ts":"2026-`, "utf8");

    const { messages, torn } = Journal.resume(p);
    expect(messages).toEqual([{ role: "user", text: "complete" }]);
    expect(torn).toBe(1);
  });

  it("keeps sequence numbers monotonic across a resume", () => {
    const p = path();
    new Journal(p).append("first");
    const { journal } = Journal.resume(p);
    const next = journal.append("second");

    expect(next.seq).toBe(2);
  });

  it("resumes cleanly from a file that does not exist yet", () => {
    const { messages, torn } = Journal.resume(path());
    expect(messages).toEqual([]);
    expect(torn).toBe(0);
  });

  it("writes one line per message, each independently parseable", () => {
    const p = path();
    const j = new Journal(p);
    j.append({ a: 1 });
    j.append({ b: "two\nlines" });

    const lines = readFileSync(p, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });
});
