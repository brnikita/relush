import { describe, expect, it } from "vitest";
import { pathsInResponse, RetrievalTracker } from "./retrieval-miss.ts";

describe("pathsInResponse", () => {
  it("extracts file paths from rendered locations", () => {
    const text = `# callers of run
function run(a: string): void  (src/app.ts:12)
method Store.query()  (src/db/store.ts:40)`;

    expect(pathsInResponse(text)).toEqual(["src/app.ts", "src/db/store.ts"]);
  });

  it("deduplicates repeated files", () => {
    const text = "a  (src/a.ts:1)\nb  (src/a.ts:9)";

    expect(pathsInResponse(text)).toEqual(["src/a.ts"]);
  });

  it("returns nothing for a response with no locations", () => {
    expect(pathsInResponse("no match for symbol foo")).toEqual([]);
  });
});

describe("RetrievalTracker", () => {
  it("flags a read of a file a query already covered", () => {
    // The graph answered and the model read the file anyway: tokens spent twice.
    const tracker = new RetrievalTracker();
    tracker.recordQuery("q1", "references", ["src/app.ts"], 120);
    tracker.nextTurn();

    const miss = tracker.recordRead("src/app.ts", 4000);

    expect(miss).toBeDefined();
    expect(miss?.wastedTokens).toBe(4000);
    expect(miss?.turnsLater).toBe(1);
  });

  it("does not flag a read of an uncovered file", () => {
    const tracker = new RetrievalTracker();
    tracker.recordQuery("q1", "references", ["src/app.ts"], 120);

    expect(tracker.recordRead("src/other.ts", 4000)).toBeUndefined();
  });

  it("does not flag reading a file after asking for its overview", () => {
    // An outline is what tells you a file is worth reading; that progression
    // is the tool working, not failing.
    const tracker = new RetrievalTracker();
    tracker.recordQuery("q1", "overview", ["src/app.ts"], 120);

    expect(tracker.recordRead("src/app.ts", 4000)).toBeUndefined();
  });

  it("reports a miss rate over queries made", () => {
    const tracker = new RetrievalTracker();
    tracker.recordQuery("q1", "references", ["a.ts"], 10);
    tracker.recordQuery("q2", "references", ["b.ts"], 10);
    tracker.recordRead("a.ts", 100);

    expect(tracker.missRate).toBe(0.5);
  });

  it("reports zero rather than NaN before any query", () => {
    expect(new RetrievalTracker().missRate).toBe(0);
  });

  it("accumulates every miss for later analysis", () => {
    const tracker = new RetrievalTracker();
    tracker.recordQuery("q1", "references", ["a.ts", "b.ts"], 10);
    tracker.recordRead("a.ts", 100);
    tracker.recordRead("b.ts", 200);

    expect(tracker.recorded).toHaveLength(2);
    expect(tracker.recorded.map((m) => m.wastedTokens)).toEqual([100, 200]);
  });
});
