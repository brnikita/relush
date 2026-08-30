/**
 * Code graph: `web-tree-sitter` indexer and the `GraphStore` (SPEC §4.2).
 *
 * Per ADR-001 the sole store is SQLite on `node:sqlite`; the interface and its
 * conformance suite are kept so a second backend stays a drop-in.
 */
export const PACKAGE = "graph" as const;
