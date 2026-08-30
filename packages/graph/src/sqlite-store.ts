import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  FileRecord,
  GraphEdge,
  GraphNode,
  GraphStore,
  NeighbourQuery,
  NodeKind,
  NodeQuery,
} from "./types.ts";

/**
 * `GraphStore` on `node:sqlite` (SPEC §4.2, ADR-001).
 *
 * SQLite is the sole implementation. Kùzu, the spec's original choice, was
 * acquired and archived upstream; `node:sqlite` ships with Node 22+ and needs no
 * dependency at all, which preserves the project's no-native-dependency
 * property.
 *
 * The cost of that choice is traversal: there is no Cypher, so transitive
 * queries are recursive CTEs. Those are written out here rather than generated,
 * because `impact()` and transitive `references` are the queries most at risk of
 * missing the §4.2 p95 gate and they need to stay readable enough to tune.
 */

interface NodeRow {
  id: string;
  kind: string;
  name: string;
  path: string;
  start_line: number;
  end_line: number;
  signature: string | null;
  doc_line: string | null;
  language: string | null;
}

const toNode = (row: NodeRow): GraphNode => ({
  id: row.id,
  kind: row.kind as NodeKind,
  name: row.name,
  path: row.path,
  startLine: row.start_line,
  endLine: row.end_line,
  // Absent optionals are omitted rather than set to undefined, so a stored node
  // deep-equals the one that was written.
  ...(row.signature === null ? {} : { signature: row.signature }),
  ...(row.doc_line === null ? {} : { docLine: row.doc_line }),
  ...(row.language === null ? {} : { language: row.language }),
});

export interface SqliteStoreOptions {
  /** File path, or `:memory:`. */
  readonly path: string;
}

export class SqliteGraphStore implements GraphStore {
  private readonly db: DatabaseSync;

  constructor(options: SqliteStoreOptions) {
    if (options.path !== ":memory:") mkdirSync(dirname(options.path), { recursive: true });
    this.db = new DatabaseSync(options.path);
    // WAL keeps the fs watcher's incremental writes from blocking queries.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
  }

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id         TEXT PRIMARY KEY,
        kind       TEXT NOT NULL,
        name       TEXT NOT NULL,
        path       TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line   INTEGER NOT NULL,
        signature  TEXT,
        doc_line   TEXT,
        language   TEXT
      );

      CREATE TABLE IF NOT EXISTS edges (
        from_id TEXT NOT NULL,
        to_id   TEXT NOT NULL,
        kind    TEXT NOT NULL,
        PRIMARY KEY (from_id, to_id, kind)
      );

      CREATE TABLE IF NOT EXISTS files (
        path       TEXT PRIMARY KEY,
        hash       TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );

      -- Lookups by name and path dominate; traversal hits both edge directions.
      CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes (name);
      CREATE INDEX IF NOT EXISTS idx_nodes_path ON nodes (path);
      CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes (kind);
      CREATE INDEX IF NOT EXISTS idx_edges_from ON edges (from_id, kind);
      CREATE INDEX IF NOT EXISTS idx_edges_to   ON edges (to_id, kind);
    `);
  }

  putNodes(nodes: readonly GraphNode[]): void {
    if (nodes.length === 0) return;

    const statement = this.db.prepare(`
      INSERT INTO nodes (id, kind, name, path, start_line, end_line, signature, doc_line, language)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind, name = excluded.name, path = excluded.path,
        start_line = excluded.start_line, end_line = excluded.end_line,
        signature = excluded.signature, doc_line = excluded.doc_line,
        language = excluded.language
    `);

    // One transaction per batch: indexing a large repo writes hundreds of
    // thousands of rows, and a transaction per row misses the §4.2 gate.
    this.db.exec("BEGIN");
    try {
      for (const node of nodes) {
        statement.run(
          node.id,
          node.kind,
          node.name,
          node.path,
          node.startLine,
          node.endLine,
          node.signature ?? null,
          node.docLine ?? null,
          node.language ?? null,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  putEdges(edges: readonly GraphEdge[]): void {
    if (edges.length === 0) return;

    const statement = this.db.prepare(
      "INSERT OR IGNORE INTO edges (from_id, to_id, kind) VALUES (?, ?, ?)",
    );

    this.db.exec("BEGIN");
    try {
      for (const edge of edges) statement.run(edge.from, edge.to, edge.kind);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getNode(id: string): GraphNode | undefined {
    const row = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as unknown as
      | NodeRow
      | undefined;
    return row ? toNode(row) : undefined;
  }

  findNodes(query: NodeQuery): GraphNode[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];

    if (query.name !== undefined) {
      clauses.push("name = ?");
      params.push(query.name);
    }
    if (query.kind !== undefined) {
      clauses.push("kind = ?");
      params.push(query.kind);
    }
    if (query.path !== undefined) {
      clauses.push("path = ?");
      params.push(query.path);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = query.limit === undefined ? "" : "LIMIT ?";
    if (query.limit !== undefined) params.push(query.limit);

    const rows = this.db
      .prepare(`SELECT * FROM nodes ${where} ORDER BY path, start_line ${limit}`)
      .all(...params) as unknown as NodeRow[];

    return rows.map(toNode);
  }

  /**
   * Transitive traversal in one recursive CTE.
   *
   * `direction` selects outgoing (`neighbours`) or incoming (`dependents`).
   * The `depth` guard and `UNION` (not `UNION ALL`) together terminate on
   * cycles — mutual recursion is ordinary in real code and a naive walk hangs.
   */
  private traverse(query: NeighbourQuery, direction: "out" | "in"): GraphNode[] {
    const depth = Math.max(1, query.depth ?? 1);
    const [sourceCol, targetCol] =
      direction === "out" ? ["from_id", "to_id"] : ["to_id", "from_id"];

    const kindFilter = query.kind === undefined ? "" : "AND e.kind = ?";
    const params: (string | number)[] = [query.id];
    if (query.kind !== undefined) params.push(query.kind);
    params.push(depth);
    if (query.kind !== undefined) params.push(query.kind);
    if (query.limit !== undefined) params.push(query.limit);

    const sql = `
      WITH RECURSIVE reachable(id, depth) AS (
        SELECT e.${targetCol}, 1
          FROM edges e
         WHERE e.${sourceCol} = ? ${kindFilter}
        UNION
        SELECT e.${targetCol}, r.depth + 1
          FROM edges e
          JOIN reachable r ON e.${sourceCol} = r.id
         WHERE r.depth < ? ${kindFilter}
      )
      -- Membership test rather than a join: UNION inside the CTE dedupes on
      -- (id, depth), so a node reachable at two depths appears twice, and a
      -- cycle yields one row per depth. Selecting by id collapses those.
      -- It also drops edges to symbols not yet indexed, which is normal during
      -- incremental indexing and must not produce phantom nodes.
      SELECT n.* FROM nodes n
       WHERE n.id IN (SELECT id FROM reachable)
       ORDER BY n.path, n.start_line
       ${query.limit === undefined ? "" : "LIMIT ?"}
    `;

    return (this.db.prepare(sql).all(...params) as unknown as NodeRow[]).map(toNode);
  }

  neighbours(query: NeighbourQuery): GraphNode[] {
    return this.traverse(query, "out");
  }

  dependents(query: NeighbourQuery): GraphNode[] {
    return this.traverse(query, "in");
  }

  nodesInFile(path: string): GraphNode[] {
    const rows = this.db
      .prepare("SELECT * FROM nodes WHERE path = ? ORDER BY start_line")
      .all(path) as unknown as NodeRow[];
    return rows.map(toNode);
  }

  removeFile(path: string): void {
    this.db.exec("BEGIN");
    try {
      // Edges first: dropping the nodes first would orphan them.
      this.db
        .prepare(`
          DELETE FROM edges
           WHERE from_id IN (SELECT id FROM nodes WHERE path = ?)
              OR to_id   IN (SELECT id FROM nodes WHERE path = ?)
        `)
        .run(path, path);
      this.db.prepare("DELETE FROM nodes WHERE path = ?").run(path);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getFileRecord(path: string): FileRecord | undefined {
    const row = this.db.prepare("SELECT * FROM files WHERE path = ?").get(path) as
      | { path: string; hash: string; indexed_at: string }
      | undefined;
    return row ? { path: row.path, hash: row.hash, indexedAt: row.indexed_at } : undefined;
  }

  putFileRecord(record: FileRecord): void {
    this.db
      .prepare(`
        INSERT INTO files (path, hash, indexed_at) VALUES (?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, indexed_at = excluded.indexed_at
      `)
      .run(record.path, record.hash, record.indexedAt);
  }

  allFileRecords(): FileRecord[] {
    const rows = this.db.prepare("SELECT * FROM files ORDER BY path").all() as unknown as {
      path: string;
      hash: string;
      indexed_at: string;
    }[];
    return rows.map((r) => ({ path: r.path, hash: r.hash, indexedAt: r.indexed_at }));
  }

  stats(): { nodes: number; edges: number; files: number } {
    const count = (table: string): number =>
      (this.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as unknown as { c: number }).c;

    return { nodes: count("nodes"), edges: count("edges"), files: count("files") };
  }

  close(): void {
    this.db.close();
  }
}
