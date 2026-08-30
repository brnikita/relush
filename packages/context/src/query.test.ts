import type { GraphStore } from "@nodrel/graph";
import { indexSource, resolveCrossFileCalls, SqliteGraphStore } from "@nodrel/graph";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_BUDGET, fitToBudget, graphQuery, renderNode } from "./query.ts";

const countTokens = (text: string) => Math.ceil(text.length / 4);

const q = (store: GraphStore, op: string, arg: string, extra = {}) =>
  graphQuery({ op: op as never, arg, ...extra }, { store, countTokens });

let store: GraphStore;

beforeAll(async () => {
  store = new SqliteGraphStore({ path: ":memory:" });
  store.init();

  const files: Record<string, string> = {
    "src/lib.ts": `/**
 * Formats a number as currency.
 */
export function formatMoney(value: number, currency: string): string { return ""; }
export function unused(): void {}`,
    "src/app.ts": `import { formatMoney } from "./lib.ts";
/** Renders the cart total. */
export function renderTotal(items: number[]): string { return formatMoney(1, "usd"); }`,
    "src/app.test.ts": `import { renderTotal } from "./app.ts";
function checksTotal(): void { renderTotal([]); }`,
  };

  for (const [path, source] of Object.entries(files)) {
    const indexed = await indexSource(path, source);
    store.putNodes(indexed?.nodes ?? []);
    store.putEdges(indexed?.edges ?? []);
  }
  resolveCrossFileCalls(store);
});

describe("renderNode", () => {
  it("emits a signature and doc, never a body", () => {
    const node = store.findNodes({ name: "formatMoney" })[0];
    const line = renderNode(node as never);

    expect(line).toContain("formatMoney");
    expect(line).toContain("currency: string");
    expect(line).toContain("Formats a number as currency.");
    expect(line).toContain("src/lib.ts:4");
    // A body would defeat the purpose of the graph.
    expect(line).not.toContain("return");
  });
});

describe("fitToBudget", () => {
  const many = Array.from({ length: 200 }, (_, i) => ({
    id: `n${i}`,
    kind: "function" as const,
    name: `symbol_${i}`,
    path: "src/big.ts",
    startLine: i,
    endLine: i,
    signature: `symbol_${i}(a: string, b: number): void`,
  }));

  it("never exceeds the budget", () => {
    const fitted = fitToBudget(many, 200, countTokens, "# header");

    expect(fitted.tokens).toBeLessThanOrEqual(200);
  });

  it("returns the overflow as expandable ids rather than dropping it", () => {
    const fitted = fitToBudget(many, 200, countTokens, "# header");

    expect(fitted.truncated.length).toBeGreaterThan(0);
    expect(fitted.truncated.length + (fitted.text.split("\n").length - 2)).toBe(many.length);
  });

  it("says how many results were withheld", () => {
    // A silently short list reads as a complete answer and the model stops.
    expect(fitToBudget(many, 200, countTokens, "# h").text).toMatch(/\d+ more not shown/);
  });

  it("keeps the highest-ranked results, truncating the tail", () => {
    const fitted = fitToBudget(many, 200, countTokens, "# h");

    expect(fitted.text).toContain("symbol_0");
    expect(fitted.truncated).toContain("n199");
  });

  it("adds no truncation note when everything fits", () => {
    expect(fitToBudget(many.slice(0, 2), 10_000, countTokens, "# h").text).not.toMatch(/not shown/);
  });
});

describe("graph_query operations", () => {
  it("overview lists a file's symbols without its body", () => {
    const response = q(store, "overview", "src/lib.ts");

    expect(response.text).toContain("formatMoney");
    expect(response.text).toContain("unused");
    expect(response.totalResults).toBe(2);
  });

  it("symbol resolves a bare name", () => {
    expect(q(store, "symbol", "formatMoney").text).toContain("currency: string");
  });

  it("symbol resolves a qualified id", () => {
    expect(q(store, "symbol", "src/lib.ts#formatMoney").totalResults).toBe(1);
  });

  it("references answers 'who calls this' across files", () => {
    const response = q(store, "references", "formatMoney");

    expect(response.text).toContain("renderTotal");
  });

  it("references says so plainly when nothing calls the symbol", () => {
    expect(q(store, "references", "unused").text).toMatch(/no recorded callers/);
  });

  it("dependencies answers 'what does this call'", () => {
    expect(q(store, "dependencies", "renderTotal").text).toContain("formatMoney");
  });

  it("impact reports the blast radius in symbols and files", () => {
    const response = q(store, "impact", "formatMoney");

    // The router uses this size to decide whether to escalate.
    expect(response.text).toMatch(/impact of formatMoney: \d+ symbols across \d+ files/);
    expect(response.text).toContain("renderTotal");
  });

  it("tests_for finds a covering test", () => {
    expect(q(store, "tests_for", "renderTotal").text).toContain("checksTotal");
  });

  it("tests_for says so when nothing covers the symbol", () => {
    expect(q(store, "tests_for", "unused").text).toMatch(/no tests found/);
  });

  it("search ranks an exact name match first", () => {
    const response = q(store, "search", "formatMoney");
    const firstLine = response.text.split("\n")[1] ?? "";

    expect(firstLine).toContain("formatMoney");
  });

  it("search matches doc text, not just identifiers", () => {
    expect(q(store, "search", "currency").text).toContain("formatMoney");
  });

  it("reports no match rather than throwing on an unknown symbol", () => {
    expect(q(store, "symbol", "doesNotExist").text).toMatch(/no match/);
    expect(q(store, "overview", "src/absent.ts").text).toMatch(/no match/);
  });

  it("rejects an unknown operation without throwing", () => {
    expect(q(store, "nonsense", "x").text).toMatch(/unknown operation/);
  });

  it("honours an explicit budget", () => {
    const response = q(store, "overview", "src/lib.ts", { budget: 20 });

    expect(response.tokens).toBeLessThanOrEqual(20);
  });

  it("defaults to the SPEC §4.3 budget", () => {
    expect(DEFAULT_BUDGET).toBe(4000);
    expect(q(store, "overview", "src/lib.ts").tokens).toBeLessThanOrEqual(DEFAULT_BUDGET);
  });
});

describe("token economics", () => {
  it("costs far less than reading the file it describes", async () => {
    // This is the whole premise: ~10x fewer tokens than a whole-file read.
    const source = `${"// filler comment line\n".repeat(200)}
export function target(a: string): void {}`;
    const local = new SqliteGraphStore({ path: ":memory:" });
    local.init();
    const indexed = await indexSource("src/big.ts", source);
    local.putNodes(indexed?.nodes ?? []);
    local.putEdges(indexed?.edges ?? []);

    const wholeFile = countTokens(source);
    const viaGraph = graphQuery(
      { op: "overview", arg: "src/big.ts" },
      { store: local, countTokens },
    ).tokens;

    expect(viaGraph).toBeLessThan(wholeFile / 10);
    local.close();
  });
});
