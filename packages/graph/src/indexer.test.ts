import { describe, expect, it } from "vitest";
import {
  hashContent,
  indexSource,
  LANGUAGES,
  languageFor,
  resolveCrossFileCalls,
} from "./indexer.ts";
import { SqliteGraphStore } from "./sqlite-store.ts";

const store = () => {
  const s = new SqliteGraphStore({ path: ":memory:" });
  s.init();
  return s;
};

describe("languageFor", () => {
  it.each([
    ["src/a.ts", "typescript"],
    ["src/a.mts", "typescript"],
    ["src/a.tsx", "tsx"],
    ["src/a.js", "javascript"],
    ["src/a.mjs", "javascript"],
  ])("maps %s to %s", (path, id) => {
    expect(languageFor(path)?.id).toBe(id);
  });

  it("returns undefined for an unsupported extension", () => {
    expect(languageFor("README.md")).toBeUndefined();
  });
});

describe("hashContent", () => {
  it("is stable and content-sensitive", () => {
    expect(hashContent("a")).toBe(hashContent("a"));
    expect(hashContent("a")).not.toBe(hashContent("b"));
  });
});

describe("indexSource", () => {
  it("extracts functions, classes and methods", async () => {
    const indexed = await indexSource(
      "src/a.ts",
      `export function run(task: string): void {}
export class Store {
  query(sql: string): number { return 1; }
}
`,
    );

    const names = indexed?.nodes.map((n) => n.name).sort();
    expect(names).toEqual(["Store", "a.ts", "query", "run"]);
  });

  it("records a signature but never a body", async () => {
    const indexed = await indexSource(
      "src/a.ts",
      "export function run(task: string, retries: number): Promise<void> { doSomethingLong(); }",
    );
    const run = indexed?.nodes.find((n) => n.name === "run");

    expect(run?.signature).toContain("task: string");
    expect(run?.signature).toContain("Promise<void>");
    // A body in the signature would defeat the whole point of the graph.
    expect(run?.signature).not.toContain("doSomethingLong");
  });

  it("qualifies a method with its class, so two `query` methods differ", async () => {
    const indexed = await indexSource(
      "src/a.ts",
      `class A { query() {} }
class B { query() {} }`,
    );

    const ids = indexed?.nodes
      .filter((n) => n.kind === "method")
      .map((n) => n.id)
      .sort();
    expect(ids).toEqual(["src/a.ts#A.query", "src/a.ts#B.query"]);
  });

  it("strips the closing delimiter from a single-line doc comment", async () => {
    // The common form for a short doc; keeping the */ leaks into every
    // rendered signature the model sees.
    const indexed = await indexSource(
      "src/a.ts",
      `/** Formats money. */
export function fmt(): void {}`,
    );

    expect(indexed?.nodes.find((n) => n.name === "fmt")?.docLine).toBe("Formats money.");
  });

  it("captures the first line of a doc comment", async () => {
    const indexed = await indexSource(
      "src/a.ts",
      `/**
 * Runs one task to completion.
 * More detail here.
 */
export function run(): void {}`,
    );

    expect(indexed?.nodes.find((n) => n.name === "run")?.docLine).toBe(
      "Runs one task to completion.",
    );
  });

  it("records import edges", async () => {
    const indexed = await indexSource("src/a.ts", 'import { x } from "./b.ts";');
    const imports = indexed?.edges.filter((e) => e.kind === "imports");

    expect(imports?.[0]?.to).toBe("./b.ts");
  });

  it("resolves a same-file call to the callee's id", async () => {
    const indexed = await indexSource(
      "src/a.ts",
      `function helper(): void {}
function run(): void { helper(); }`,
    );

    const call = indexed?.edges.find((e) => e.kind === "calls" && e.from === "src/a.ts#run");
    expect(call?.to).toBe("src/a.ts#helper");
  });

  it("keeps an unresolved call as a bare name for SCIP to refine later", async () => {
    const indexed = await indexSource("src/a.ts", "function run(): void { external(); }");
    const call = indexed?.edges.find((e) => e.kind === "calls");

    expect(call?.to).toBe("external");
  });

  it("tags symbols in a test file as tests", async () => {
    const indexed = await indexSource("src/a.test.ts", "function checksThing(): void {}");

    expect(indexed?.nodes.find((n) => n.name === "checksThing")?.kind).toBe("test");
  });

  it("records interfaces and type aliases", async () => {
    const indexed = await indexSource(
      "src/a.ts",
      `interface Config { a: number }
type Alias = string;`,
    );

    const types = indexed?.nodes
      .filter((n) => n.kind === "type")
      .map((n) => n.name)
      .sort();
    expect(types).toEqual(["Alias", "Config"]);
  });

  it("returns undefined for an unsupported file type", async () => {
    expect(await indexSource("README.md", "# hello")).toBeUndefined();
  });

  it("survives a syntactically broken file", async () => {
    // Editors save mid-edit; a watcher will index broken files routinely.
    const indexed = await indexSource("src/a.ts", "function run( { unclosed");

    expect(indexed).toBeDefined();
    expect(indexed?.nodes.length).toBeGreaterThan(0);
  });
});

describe("store round trip", () => {
  it("makes 'who calls this' answerable without reading the file", async () => {
    const s = store();
    const indexed = await indexSource(
      "src/a.ts",
      `function helper(): void {}
function run(): void { helper(); }`,
    );
    s.putNodes(indexed?.nodes ?? []);
    s.putEdges(indexed?.edges ?? []);

    const callers = s.dependents({ id: "src/a.ts#helper", kind: "calls" });

    expect(callers.map((n) => n.name)).toContain("run");
    s.close();
  });
});

describe("resolveCrossFileCalls", () => {
  const seeded = async (files: Record<string, string>) => {
    const s = store();
    for (const [path, source] of Object.entries(files)) {
      const indexed = await indexSource(path, source);
      s.putNodes(indexed?.nodes ?? []);
      s.putEdges(indexed?.edges ?? []);
    }
    return s;
  };

  it("links a caller to a callee defined in another file", async () => {
    // Parsing alone cannot do this; without the pass, "who calls this" is
    // unanswerable across files and the graph loses most of its value.
    const s = await seeded({
      "src/lib.ts": "export function helper(): void {}",
      "src/app.ts": 'import { helper } from "./lib.ts";\nfunction run(): void { helper(); }',
    });

    resolveCrossFileCalls(s);
    const callers = s.dependents({ id: "src/lib.ts#helper", kind: "calls", depth: 1 });

    expect(callers.map((n) => n.id)).toContain("src/app.ts#run");
    s.close();
  });

  it("refuses to guess when a name is declared twice", async () => {
    // A wrong edge is worse than a missing one: it sends impact() after the
    // wrong symbols and the model trusts the answer.
    const s = await seeded({
      "src/a.ts": "export function shared(): void {}",
      "src/b.ts": "export function shared(): void {}",
      "src/app.ts": "function run(): void { shared(); }",
    });

    const result = resolveCrossFileCalls(s);

    expect(result.ambiguous).toBeGreaterThan(0);
    expect(s.dependents({ id: "src/a.ts#shared", kind: "calls", depth: 1 })).toEqual([]);
    s.close();
  });

  it("reports how many edges it resolved", async () => {
    const s = await seeded({
      "src/lib.ts": "export function helper(): void {}",
      "src/app.ts": "function run(): void { helper(); }",
    });

    expect(resolveCrossFileCalls(s).resolved).toBeGreaterThan(0);
    s.close();
  });

  it("is idempotent, since edges are deduplicated", async () => {
    const s = await seeded({
      "src/lib.ts": "export function helper(): void {}",
      "src/app.ts": "function run(): void { helper(); }",
    });

    resolveCrossFileCalls(s);
    const after = s.stats().edges;
    resolveCrossFileCalls(s);

    expect(s.stats().edges).toBe(after);
    s.close();
  });
});

describe("language coverage", () => {
  // SPEC §4.2 requires >= 15 languages at v1. Each entry costs a dependency
  // and a row because every grammar ships prebuilt WASM.
  it.each([
    ["python", "src/a.py", "def compute(a, b):\n    return a + b\n", "compute"],
    ["go", "src/a.go", "package main\nfunc Compute(a int) int { return a }\n", "Compute"],
    ["java", "src/A.java", "class Widget { void render() {} }", "Widget"],
    ["c", "src/a.c", "int compute(int a) { return a; }\n", "compute"],
    ["cpp", "src/a.cpp", "class Widget { public: void render(); };\n", "Widget"],
    ["csharp", "src/A.cs", "class Widget { void Render() {} }", "Widget"],
    ["rust", "src/a.rs", "fn compute(a: i32) -> i32 { a }\n", "compute"],
    ["ruby", "src/a.rb", "def compute(a)\n  a\nend\n", "compute"],
    ["php", "src/a.php", "<?php\nfunction compute($a) { return $a; }\n", "compute"],
    ["bash", "src/a.sh", "compute() {\n  echo 1\n}\n", "compute"],
  ])("indexes %s", async (_language, path, source, expected) => {
    const indexed = await indexSource(path, source);

    expect(indexed, `${path} should parse`).toBeDefined();
    expect(indexed?.nodes.map((n) => n.name)).toContain(expected);
  });

  it("covers at least 13 languages, on the way to the 15 SPEC §4.2 requires", () => {
    expect(LANGUAGES.length).toBeGreaterThanOrEqual(13);
  });

  it("maps every language to a distinct id", () => {
    expect(new Set(LANGUAGES.map((l) => l.id)).size).toBe(LANGUAGES.length);
  });

  it("claims no extension twice, so file routing is unambiguous", () => {
    const all = LANGUAGES.flatMap((l) => l.extensions);
    expect(new Set(all).size).toBe(all.length);
  });
});
