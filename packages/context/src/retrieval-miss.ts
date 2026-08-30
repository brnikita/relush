/**
 * Retrieval-miss detection (SPEC §4.3).
 *
 * A miss is the model reading a whole file that a preceding `graph_query`
 * already covered. Each one means the graph answered, the model did not trust
 * the answer, and the tokens were spent twice.
 *
 * This is the tuning signal for the context engine. Without it, a graph that
 * returns technically-correct but unhelpful answers looks identical to one that
 * works: both show `graph_query` calls in the telemetry, and only the token
 * count differs.
 */

export interface RetrievalMiss {
  readonly queryId: string;
  readonly path: string;
  readonly wastedTokens: number;
  /** Turns between the query and the read that made it redundant. */
  readonly turnsLater: number;
}

interface CoveredQuery {
  readonly queryId: string;
  readonly op: string;
  readonly paths: ReadonlySet<string>;
  readonly tokens: number;
  readonly turn: number;
}

/**
 * Tracks which files a session's graph queries have covered.
 *
 * Coverage is by file path: a query that returned symbols from `src/a.ts`
 * covers `src/a.ts`. A later read of that file is a miss, because the
 * signatures were already in context.
 */
export class RetrievalTracker {
  private readonly covered: CoveredQuery[] = [];
  private turn = 0;
  private readonly misses: RetrievalMiss[] = [];

  /** Advances the turn counter. Called once per assistant turn. */
  nextTurn(): void {
    this.turn += 1;
  }

  /** Records what a graph query covered. */
  recordQuery(queryId: string, op: string, paths: readonly string[], tokens: number): void {
    this.covered.push({ queryId, op, paths: new Set(paths), tokens, turn: this.turn });
  }

  /**
   * Records a file read, returning a miss if a query already covered it.
   *
   * `overview` is excluded from counting as coverage for the same file, since
   * asking for a file's outline and then reading it is a legitimate
   * progression: the outline is what tells you the file is worth reading.
   */
  recordRead(path: string, tokens: number): RetrievalMiss | undefined {
    const covering = this.covered.find((query) => query.op !== "overview" && query.paths.has(path));
    if (!covering) return undefined;

    const miss: RetrievalMiss = {
      queryId: covering.queryId,
      path,
      wastedTokens: tokens,
      turnsLater: this.turn - covering.turn,
    };
    this.misses.push(miss);
    return miss;
  }

  /** Every miss recorded this session. */
  get recorded(): readonly RetrievalMiss[] {
    return this.misses;
  }

  /**
   * Share of graph queries that were followed by a redundant read.
   *
   * The number to watch: a rising rate means the graph is answering in a form
   * the model does not trust, which is a retrieval problem rather than a model
   * problem.
   */
  get missRate(): number {
    return this.covered.length === 0 ? 0 : this.misses.length / this.covered.length;
  }
}

/** Extracts the file paths a rendered graph response referred to. */
export function pathsInResponse(text: string): string[] {
  const paths = new Set<string>();
  // Responses render locations as `(path:line)`.
  for (const match of text.matchAll(/\(([^()\s]+?):\d+\)/g)) {
    const path = match[1];
    if (path !== undefined) paths.add(path);
  }
  return [...paths].sort();
}
