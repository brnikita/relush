import type { GraphStore } from "@nodrel/graph";
import { indexSource, SqliteGraphStore } from "@nodrel/graph";
import { beforeAll, describe, expect, it } from "vitest";
import { buildTaskMap, DEFAULT_TASK_MAP_BUDGET } from "./task-map.ts";

const countTokens = (text: string) => Math.ceil(text.length / 4);

let store: GraphStore;

beforeAll(async () => {
  store = new SqliteGraphStore({ path: ":memory:" });
  store.init();

  const files: Record<string, string> = {
    "src/payment.ts": `/** Charges a card. */
export function chargeCard(amount: number): boolean { return true; }
export function refund(id: string): void {}`,
    "src/user.ts": `/** Validates a user's email address. */
export function validateEmail(email: string): boolean { return true; }`,
    "src/util.ts": "export function noop(): void {}",
  };

  for (const [path, source] of Object.entries(files)) {
    const indexed = await indexSource(path, source);
    store.putNodes(indexed?.nodes ?? []);
    store.putEdges(indexed?.edges ?? []);
  }
});

const map = (prompt: string, budget?: number) =>
  buildTaskMap({
    store,
    countTokens,
    prompt,
    ...(budget === undefined ? {} : { budget }),
  });

describe("buildTaskMap", () => {
  it("lists the repository's files", () => {
    const result = map("anything");

    expect(result.text).toContain("src/payment.ts");
    expect(result.text).toContain("src/user.ts");
  });

  it("surfaces symbols matching the prompt", () => {
    expect(map("fix the chargeCard bug").text).toContain("chargeCard");
  });

  it("matches on doc text, not just identifiers", () => {
    // "email" appears in validateEmail's doc line and its name.
    expect(map("something about email addresses").text).toContain("validateEmail");
  });

  it("omits symbols the prompt does not mention", () => {
    const result = map("fix the chargeCard bug");

    expect(result.text).toContain("chargeCard");
    expect(result.text).not.toContain("noop(");
  });

  it("is byte-identical across runs on identical input", () => {
    // The map lives inside the pinned prefix; any nondeterminism costs every
    // cache hit for the rest of the session.
    const first = map("fix the chargeCard bug");
    const runs = Array.from({ length: 20 }, () => map("fix the chargeCard bug").text);

    for (const [index, text] of runs.entries()) {
      expect(text, `run ${index}`).toBe(first.text);
    }
  });

  it("orders tied symbols deterministically", () => {
    // Two symbols scoring equally must not swap places between runs.
    const a = map("function").text;
    const b = map("function").text;

    expect(a).toBe(b);
  });

  it("respects its token budget", () => {
    expect(map("charge", 60).tokens).toBeLessThanOrEqual(60);
  });

  it("defaults to a budget well under the fixed-overhead ceiling", () => {
    // It is pinned context, so it competes with the system prompt.
    expect(DEFAULT_TASK_MAP_BUDGET).toBeLessThan(2000);
    expect(map("charge").tokens).toBeLessThanOrEqual(DEFAULT_TASK_MAP_BUDGET);
  });

  it("still produces a repo map when nothing matches the prompt", () => {
    const result = map("zzzz-nothing-matches-zzzz");

    expect(result.text).toContain("# Repository map");
    expect(result.symbolsIncluded).toBe(0);
  });

  it("reports how many symbols it included", () => {
    expect(map("charge").symbolsIncluded).toBeGreaterThan(0);
  });
});
