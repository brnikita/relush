/**
 * Code graph: `web-tree-sitter` indexer and the `GraphStore` (SPEC §4.2).
 *
 * Per ADR-001 the sole store is SQLite on `node:sqlite`; the interface and its
 * conformance suite are kept so a second backend stays a drop-in.
 */
export { runGraphStoreConformance } from "./conformance.ts";
export type { IndexedFile, IndexResult, LanguageSpec } from "./indexer.ts";
export {
  hashContent,
  indexFiles,
  indexSource,
  LANGUAGES,
  languageFor,
  resolveCrossFileCalls,
} from "./indexer.ts";
export type { McpRequest, McpResponse, McpServerOptions } from "./mcp.ts";
export { handleMcpRequest, parseMcpLine } from "./mcp.ts";
export type { SqliteStoreOptions } from "./sqlite-store.ts";
export { SqliteGraphStore } from "./sqlite-store.ts";
export type {
  EdgeKind,
  FileRecord,
  GraphEdge,
  GraphNode,
  GraphStore,
  NeighbourQuery,
  NodeKind,
  NodeQuery,
} from "./types.ts";
export { EDGE_KINDS, NODE_KINDS } from "./types.ts";

export const PACKAGE = "graph" as const;
