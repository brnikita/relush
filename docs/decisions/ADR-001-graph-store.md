# ADR-001: Graph store and parser runtime

- Status: Accepted
- Date: 2026-08-30
- Supersedes: SPEC.md §8 row 1 ("Graph DB — Default: Kùzu, SQLite fallback")

## Context

SPEC §4.2 requires an embedded graph store behind a `GraphStore` interface, with
Kùzu as the default and SQLite as a fallback, both passing the same conformance
suite. SPEC §8 sets the revisit trigger as "Kùzu binary size or query p95 fails
gate → flip default".

F0 spiked both, plus the parser runtime, on the target machine.

## Findings

**Kùzu is abandoned.** `github.com/kuzudb/kuzu` is **archived** (`archived: true`),
last pushed 2025-10-10, final release v0.11.3 on the same day. The npm package
`kuzu@0.11.3` is **deprecated** ("Package no longer supported").

It is not technically broken — it installed on Windows without a compiler via a
prebuilt binding, and executed Cypher correctly:

```
CREATE NODE TABLE Fn(name STRING, PRIMARY KEY(name))
MATCH (f:Fn) RETURN f.name   ->  [{"f.name":"baz"}]
```

So this is not a performance flip. It is a supply-chain judgment: an archived,
deprecated database receives no security patches and no bug fixes.

**`node:sqlite` is built into Node 24** and needs no dependency at all. Verified
working on the target machine.

**`web-tree-sitter` (WASM) parses without compilation.** Grammar packages ship
prebuilt `.wasm`; symbol extraction works end-to-end:

```
class_declaration:Foo, method_definition:bar, function_declaration:baz
```

## Decision

1. **SQLite on `node:sqlite` is the default and only `GraphStore` implementation
   for v1.** The interface and its conformance suite (F18) are retained exactly
   as specified, so a second backend remains a drop-in.
2. **Kùzu is dropped.** F27 is removed from the plan. If a property-graph engine
   is later justified by a failing §4.2 performance gate, ADR-002 will evaluate
   maintained alternatives against the same conformance suite.
3. **Parsing uses `web-tree-sitter` (WASM), not native `tree-sitter` bindings.**

## Outcome (measured 2026-08-31)

The risk this decision took was that SQLite would miss §4.2's performance gates
where a purpose-built graph engine would not. `pnpm bench:graph` on a synthetic
1M-LOC corpus (2,500 files, 167,500 nodes, 247,500 edges):

| gate | budget | measured | headroom |
|---|---|---|---|
| full index | 60 s | **32.3 s** | 1.9× |
| incremental | 5 s | **2.82 s** | 1.8× |
| incremental speedup | 4× | **11.4×** | 2.9× |
| query p95 | 100 ms | **1.8 ms** | 55× |

Query latency was the specific worry — recursive CTEs instead of Cypher — and it
came in 55× inside budget. The decision is vindicated on the evidence available.

One caveat stands: this corpus is synthetic, because `eval/corpus.lock` does not
yet pin the three OSS repos §4.2 names. Synthetic code has uniform naming and
call density, so `resolveCrossFileCalls` sees fewer ambiguous names than real
code will, and traversal fan-out is more regular. The gates are **not claimed as
met** until the real corpus lands.

## Consequences

- The project has **no native dependencies**. It builds on Windows, macOS and
  Linux without a C++ toolchain — a portability gain over the spec's design.
- SPEC §4.2's performance gates (full index 1M LOC ≤60 s, incremental ≤5 s,
  query p95 ≤100 ms) now must be met by SQLite. This is the real risk of this
  decision, and F28 (`bench:graph`) is where it is proven or disproven. If
  SQLite misses those gates, that is a genuine DEVIATION and the phase stops.
- Graph traversal must be expressed as recursive CTEs rather than Cypher, which
  makes `impact(diff)` and transitive `references` queries more work to write.
