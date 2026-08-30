/**
 * Code graph model (SPEC §4.2).
 *
 * The graph exists to answer structural questions without reading files. Its
 * schema is therefore shaped by the questions in §4.3 — "who calls this",
 * "what does this import", "which tests cover it" — rather than by what a
 * parser happens to produce.
 */

/** Node kinds from SPEC §4.2. */
export type NodeKind =
  | "file"
  | "module"
  | "class"
  | "function"
  | "method"
  | "type"
  | "test"
  | "commit";

export const NODE_KINDS: readonly NodeKind[] = [
  "file",
  "module",
  "class",
  "function",
  "method",
  "type",
  "test",
  "commit",
] as const;

/** Edge kinds from SPEC §4.2. */
export type EdgeKind =
  | "imports"
  | "calls"
  | "references"
  | "inherits"
  | "implements"
  | "tests"
  | "modified_in"
  | "co_changed_with";

export const EDGE_KINDS: readonly EdgeKind[] = [
  "imports",
  "calls",
  "references",
  "inherits",
  "implements",
  "tests",
  "modified_in",
  "co_changed_with",
] as const;

/**
 * A symbol in the graph.
 *
 * `signature` and `docLine` exist because SPEC §4.3 requires responses to be
 * signatures rather than bodies. Storing them at index time means a query never
 * has to open a file to answer.
 */
export interface GraphNode {
  /** Stable identity: `<path>#<qualifiedName>` for symbols, `<path>` for files. */
  readonly id: string;
  readonly kind: NodeKind;
  /** Bare name, e.g. `runTask`. */
  readonly name: string;
  /** Repo-relative path. */
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  /** Rendered signature: name, params, return type. Never a body. */
  readonly signature?: string;
  /** First line of the docstring or leading comment. */
  readonly docLine?: string;
  /** Language tag, e.g. `typescript`. */
  readonly language?: string;
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeKind;
}

/** A file's indexed state, for incremental reindexing. */
export interface FileRecord {
  readonly path: string;
  /** Content hash; an unchanged hash means the file can be skipped. */
  readonly hash: string;
  readonly indexedAt: string;
}

export interface NodeQuery {
  readonly name?: string;
  readonly kind?: NodeKind;
  readonly path?: string;
  readonly limit?: number;
}

export interface NeighbourQuery {
  readonly id: string;
  readonly kind?: EdgeKind;
  /** Traversal depth. 1 is direct neighbours. */
  readonly depth?: number;
  readonly limit?: number;
}

/**
 * Storage behind the context engine.
 *
 * Kept narrow deliberately. SPEC §4.2 requires any implementation to pass one
 * conformance suite, and a wide interface makes a second backend impractical —
 * which matters because the first choice of backend (Kùzu) was abandoned
 * upstream and had to be replaced (ADR-001).
 */
export interface GraphStore {
  /** Creates schema if absent. Safe to call repeatedly. */
  init(): void;

  /** Inserts or replaces nodes. Existing ids are overwritten. */
  putNodes(nodes: readonly GraphNode[]): void;

  /** Inserts edges, ignoring exact duplicates. */
  putEdges(edges: readonly GraphEdge[]): void;

  getNode(id: string): GraphNode | undefined;

  findNodes(query: NodeQuery): GraphNode[];

  /** Outgoing neighbours, optionally transitive. */
  neighbours(query: NeighbourQuery): GraphNode[];

  /** Incoming neighbours — "who points at this". */
  dependents(query: NeighbourQuery): GraphNode[];

  /** Everything defined in a file. */
  nodesInFile(path: string): GraphNode[];

  /** Removes a file's nodes and their edges. Used before reindexing it. */
  removeFile(path: string): void;

  getFileRecord(path: string): FileRecord | undefined;

  putFileRecord(record: FileRecord): void;

  /** All indexed file records, for staleness checks. */
  allFileRecords(): FileRecord[];

  stats(): { nodes: number; edges: number; files: number };

  close(): void;
}
