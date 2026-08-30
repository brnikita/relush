import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode, GraphStore } from "./types.ts";

/**
 * Conformance suite every `GraphStore` implementation must pass (SPEC §4.2).
 *
 * Written before any implementation, and exported as a function so a second
 * backend is a drop-in rather than a rewrite. That property is not theoretical:
 * the spec's original choice of backend was abandoned upstream and had to be
 * replaced (ADR-001), and the next replacement should cost one file.
 *
 * The suite encodes behaviour the context engine depends on, not the internals
 * of any store.
 */

const node = (overrides: Partial<GraphNode> & Pick<GraphNode, "id">): GraphNode => ({
  kind: "function",
  name: "fn",
  path: "src/a.ts",
  startLine: 1,
  endLine: 5,
  ...overrides,
});

const edge = (from: string, to: string, kind: GraphEdge["kind"] = "calls"): GraphEdge => ({
  from,
  to,
  kind,
});

/** Runs the suite against a factory that yields a fresh, empty store. */
export function runGraphStoreConformance(name: string, create: () => GraphStore): void {
  describe(`${name} — GraphStore conformance`, () => {
    const withStore = <T>(fn: (store: GraphStore) => T): T => {
      const store = create();
      store.init();
      try {
        return fn(store);
      } finally {
        store.close();
      }
    };

    describe("nodes", () => {
      it("stores and retrieves a node with all its fields", () => {
        withStore((store) => {
          const original = node({
            id: "src/a.ts#run",
            name: "run",
            kind: "function",
            signature: "run(task: Task): Promise<void>",
            docLine: "Runs one task.",
            language: "typescript",
            startLine: 10,
            endLine: 20,
          });

          store.putNodes([original]);

          expect(store.getNode("src/a.ts#run")).toEqual(original);
        });
      });

      it("returns undefined for an unknown id", () => {
        withStore((store) => expect(store.getNode("nope")).toBeUndefined());
      });

      it("omits absent optional fields rather than returning null", () => {
        withStore((store) => {
          store.putNodes([node({ id: "a" })]);
          const stored = store.getNode("a");

          expect(stored?.signature).toBeUndefined();
          expect(stored?.docLine).toBeUndefined();
        });
      });

      it("overwrites a node with the same id, so reindexing is idempotent", () => {
        withStore((store) => {
          store.putNodes([node({ id: "a", name: "before" })]);
          store.putNodes([node({ id: "a", name: "after" })]);

          expect(store.getNode("a")?.name).toBe("after");
          expect(store.stats().nodes).toBe(1);
        });
      });

      it("accepts an empty batch without error", () => {
        withStore((store) => {
          expect(() => store.putNodes([])).not.toThrow();
          expect(() => store.putEdges([])).not.toThrow();
        });
      });

      it("handles a batch large enough to exceed statement parameter limits", () => {
        // A 1M-LOC repo produces far more than this; a store that binds every
        // row into one statement breaks here rather than in production.
        withStore((store) => {
          const many = Array.from({ length: 5000 }, (_, i) => node({ id: `n${i}` }));
          store.putNodes(many);

          expect(store.stats().nodes).toBe(5000);
        });
      });
    });

    describe("finding nodes", () => {
      const seed = (store: GraphStore) => {
        store.putNodes([
          node({ id: "src/a.ts#run", name: "run", path: "src/a.ts", kind: "function" }),
          node({ id: "src/b.ts#run", name: "run", path: "src/b.ts", kind: "method" }),
          node({ id: "src/b.ts#Helper", name: "Helper", path: "src/b.ts", kind: "class" }),
        ]);
      };

      it("finds by exact name", () => {
        withStore((store) => {
          seed(store);
          expect(store.findNodes({ name: "run" })).toHaveLength(2);
        });
      });

      it("filters by kind", () => {
        withStore((store) => {
          seed(store);
          const found = store.findNodes({ name: "run", kind: "method" });

          expect(found).toHaveLength(1);
          expect(found[0]?.path).toBe("src/b.ts");
        });
      });

      it("filters by path", () => {
        withStore((store) => {
          seed(store);
          expect(store.findNodes({ path: "src/b.ts" })).toHaveLength(2);
        });
      });

      it("respects a limit, because responses are token-budgeted", () => {
        withStore((store) => {
          seed(store);
          expect(store.findNodes({ limit: 2 })).toHaveLength(2);
        });
      });

      it("returns an empty array rather than throwing on no match", () => {
        withStore((store) => expect(store.findNodes({ name: "absent" })).toEqual([]));
      });
    });

    describe("traversal", () => {
      /** a → b → c, plus an unrelated d. */
      const chain = (store: GraphStore) => {
        store.putNodes([
          node({ id: "a" }),
          node({ id: "b" }),
          node({ id: "c" }),
          node({ id: "d" }),
        ]);
        store.putEdges([edge("a", "b"), edge("b", "c")]);
      };

      it("returns direct neighbours at depth 1", () => {
        withStore((store) => {
          chain(store);
          expect(store.neighbours({ id: "a", depth: 1 }).map((n) => n.id)).toEqual(["b"]);
        });
      });

      it("follows the chain transitively at greater depth", () => {
        withStore((store) => {
          chain(store);
          const ids = store
            .neighbours({ id: "a", depth: 2 })
            .map((n) => n.id)
            .sort();

          expect(ids).toEqual(["b", "c"]);
        });
      });

      it("finds dependents, answering 'who calls this'", () => {
        withStore((store) => {
          chain(store);
          expect(store.dependents({ id: "c", depth: 1 }).map((n) => n.id)).toEqual(["b"]);
        });
      });

      it("finds dependents transitively, which is what impact() needs", () => {
        withStore((store) => {
          chain(store);
          const ids = store
            .dependents({ id: "c", depth: 2 })
            .map((n) => n.id)
            .sort();

          expect(ids).toEqual(["a", "b"]);
        });
      });

      it("filters traversal by edge kind", () => {
        withStore((store) => {
          store.putNodes([node({ id: "a" }), node({ id: "b" }), node({ id: "c" })]);
          store.putEdges([edge("a", "b", "calls"), edge("a", "c", "imports")]);

          const calls = store.neighbours({ id: "a", kind: "calls" }).map((n) => n.id);
          expect(calls).toEqual(["b"]);
        });
      });

      it("terminates on a cycle rather than looping forever", () => {
        // Mutual recursion is ordinary in real code; a naive traversal hangs.
        withStore((store) => {
          store.putNodes([node({ id: "a" }), node({ id: "b" })]);
          store.putEdges([edge("a", "b"), edge("b", "a")]);

          const ids = store
            .neighbours({ id: "a", depth: 10 })
            .map((n) => n.id)
            .sort();
          expect(ids).toEqual(["a", "b"]);
        });
      });

      it("excludes the starting node unless a cycle leads back to it", () => {
        withStore((store) => {
          chain(store);
          expect(store.neighbours({ id: "a", depth: 3 }).map((n) => n.id)).not.toContain("a");
        });
      });

      it("returns empty for an isolated node", () => {
        withStore((store) => {
          chain(store);
          expect(store.neighbours({ id: "d" })).toEqual([]);
        });
      });

      it("ignores edges pointing at nodes that do not exist", () => {
        // Indexing is incremental, so a call to a not-yet-indexed symbol is
        // normal and must not produce a phantom node.
        withStore((store) => {
          store.putNodes([node({ id: "a" })]);
          store.putEdges([edge("a", "missing")]);

          expect(store.neighbours({ id: "a" })).toEqual([]);
        });
      });

      it("does not duplicate a node reachable by two paths", () => {
        withStore((store) => {
          store.putNodes([node({ id: "a" }), node({ id: "b" }), node({ id: "c" })]);
          store.putEdges([edge("a", "b"), edge("a", "c"), edge("b", "c")]);

          const ids = store.neighbours({ id: "a", depth: 3 }).map((n) => n.id);
          expect(new Set(ids).size).toBe(ids.length);
        });
      });
    });

    describe("files", () => {
      it("lists everything defined in a file", () => {
        withStore((store) => {
          store.putNodes([
            node({ id: "src/a.ts#one", path: "src/a.ts" }),
            node({ id: "src/a.ts#two", path: "src/a.ts" }),
            node({ id: "src/b.ts#three", path: "src/b.ts" }),
          ]);

          expect(store.nodesInFile("src/a.ts")).toHaveLength(2);
        });
      });

      it("removes a file's nodes and the edges touching them", () => {
        // Reindexing a changed file must not leave stale symbols behind.
        withStore((store) => {
          store.putNodes([
            node({ id: "src/a.ts#one", path: "src/a.ts" }),
            node({ id: "src/b.ts#two", path: "src/b.ts" }),
          ]);
          store.putEdges([edge("src/b.ts#two", "src/a.ts#one")]);

          store.removeFile("src/a.ts");

          expect(store.nodesInFile("src/a.ts")).toEqual([]);
          expect(store.neighbours({ id: "src/b.ts#two" })).toEqual([]);
          expect(store.getNode("src/b.ts#two")).toBeDefined();
        });
      });

      it("round-trips a file record for incremental indexing", () => {
        withStore((store) => {
          const record = {
            path: "src/a.ts",
            hash: "abc123",
            indexedAt: "2026-08-31T00:00:00.000Z",
          };
          store.putFileRecord(record);

          expect(store.getFileRecord("src/a.ts")).toEqual(record);
        });
      });

      it("overwrites a file record on reindex", () => {
        withStore((store) => {
          store.putFileRecord({ path: "a", hash: "old", indexedAt: "2026-08-30T00:00:00.000Z" });
          store.putFileRecord({ path: "a", hash: "new", indexedAt: "2026-08-31T00:00:00.000Z" });

          expect(store.getFileRecord("a")?.hash).toBe("new");
          expect(store.allFileRecords()).toHaveLength(1);
        });
      });

      it("lists all file records for staleness checks", () => {
        withStore((store) => {
          store.putFileRecord({ path: "a", hash: "1", indexedAt: "2026-08-31T00:00:00.000Z" });
          store.putFileRecord({ path: "b", hash: "2", indexedAt: "2026-08-31T00:00:00.000Z" });

          expect(
            store
              .allFileRecords()
              .map((r) => r.path)
              .sort(),
          ).toEqual(["a", "b"]);
        });
      });
    });

    describe("bookkeeping", () => {
      it("reports counts", () => {
        withStore((store) => {
          store.putNodes([node({ id: "a" }), node({ id: "b" })]);
          store.putEdges([edge("a", "b")]);
          store.putFileRecord({
            path: "src/a.ts",
            hash: "h",
            indexedAt: "2026-08-31T00:00:00.000Z",
          });

          expect(store.stats()).toEqual({ nodes: 2, edges: 1, files: 1 });
        });
      });

      it("does not double-count an identical edge inserted twice", () => {
        withStore((store) => {
          store.putNodes([node({ id: "a" }), node({ id: "b" })]);
          store.putEdges([edge("a", "b")]);
          store.putEdges([edge("a", "b")]);

          expect(store.stats().edges).toBe(1);
        });
      });

      it("starts empty", () => {
        withStore((store) => expect(store.stats()).toEqual({ nodes: 0, edges: 0, files: 0 }));
      });

      it("tolerates init() being called more than once", () => {
        withStore((store) => {
          store.putNodes([node({ id: "a" })]);
          store.init();

          expect(store.getNode("a")).toBeDefined();
        });
      });
    });
  });
}
