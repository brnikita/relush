import type { GraphNode, GraphStore } from "@nodrel/graph";

/**
 * Budgeted graph retrieval (SPEC §4.3).
 *
 * Two rules make this worth having, and both are enforced here rather than
 * left to callers:
 *
 * 1. **Signatures, never bodies.** A response carries name, parameters, types
 *    and the first doc line. A body is a separate explicit fetch. This is where
 *    the ~10× token reduction comes from.
 * 2. **Every response is token-budgeted.** Over budget, results are ranked and
 *    the tail is returned as expandable ids. An unbounded "helpful" response is
 *    how a retrieval tool silently becomes as expensive as reading the file.
 */

export type GraphOperation =
  | "overview"
  | "symbol"
  | "references"
  | "dependencies"
  | "impact"
  | "tests_for"
  | "search"
  | "expand";

export interface GraphQueryRequest {
  readonly op: GraphOperation;
  readonly arg: string;
  readonly depth?: number;
  /** Maximum response tokens. */
  readonly budget?: number;
}

export interface GraphQueryResponse {
  readonly text: string;
  /** Results that did not fit, addressable via `expand`. */
  readonly truncated: readonly string[];
  readonly tokens: number;
  readonly totalResults: number;
}

/** SPEC §4.3 default. */
export const DEFAULT_BUDGET = 4000;

export interface QueryOptions {
  readonly store: GraphStore;
  readonly countTokens: (text: string) => string extends never ? never : number;
}

/**
 * One line per symbol: location, signature, doc.
 *
 * Deliberately dense. Every character is paid for on every subsequent request
 * once it enters the transcript, so this is not the place for alignment or
 * decoration.
 */
export function renderNode(node: GraphNode): string {
  const location = `${node.path}:${node.startLine}`;
  const body = node.signature ?? node.name;
  const doc = node.docLine ? `  — ${node.docLine}` : "";
  return `${node.kind} ${body}  (${location})${doc}`;
}

/**
 * Fits rendered results inside a token budget.
 *
 * Results are already ranked by the caller; this truncates the tail rather than
 * re-ranking, so the most relevant answers survive. What does not fit is
 * returned as ids the model can expand, which is what keeps a budgeted response
 * from becoming a lossy one.
 */
export function fitToBudget(
  nodes: readonly GraphNode[],
  budget: number,
  countTokens: (text: string) => number,
  header: string,
): { text: string; truncated: string[]; tokens: number } {
  const rendered = nodes.map((node) => {
    const line = renderNode(node);
    return { node, line, cost: countTokens(line) + 1 };
  });

  const headerCost = countTokens(header);
  const everything = rendered.reduce((sum, entry) => sum + entry.cost, headerCost);

  // The truncation note is itself content and must fit inside the budget.
  // Reserving for it only when truncation is actually needed keeps a response
  // that fits exactly from being trimmed for no reason.
  const noteAllowance = countTokens(
    "… 9999 more not shown (over budget). Fetch with graph_query op=expand.",
  );
  const contentBudget = everything <= budget ? budget : budget - noteAllowance;

  const lines: string[] = [header];
  const truncated: string[] = [];
  let tokens = headerCost;

  for (const entry of rendered) {
    if (tokens + entry.cost > contentBudget) {
      truncated.push(entry.node.id);
      continue;
    }
    lines.push(entry.line);
    tokens += entry.cost;
  }

  if (truncated.length > 0) {
    // Naming the count matters: a silently short list reads as a complete
    // answer, and the model stops looking.
    const note = `… ${truncated.length} more not shown (over budget). Fetch with graph_query op=expand.`;
    lines.push(note);
    tokens += countTokens(note);
  }

  return { text: lines.join("\n"), truncated, tokens };
}

const notFound = (what: string, countTokens: (t: string) => number): GraphQueryResponse => {
  const text = `no match for ${what}`;
  return { text, truncated: [], tokens: countTokens(text), totalResults: 0 };
};

/**
 * Resolves a symbol argument to nodes.
 *
 * Accepts a bare name or a fully qualified `path#name`, because the model sees
 * both forms in responses and will use either.
 */
function resolveSymbol(store: GraphStore, arg: string): GraphNode[] {
  if (arg.includes("#")) {
    const node = store.getNode(arg);
    return node ? [node] : [];
  }
  return store.findNodes({ name: arg });
}

/** Executes one graph query within its token budget. */
export function graphQuery(
  request: GraphQueryRequest,
  options: { store: GraphStore; countTokens: (text: string) => number },
): GraphQueryResponse {
  const { store, countTokens } = options;
  const budget = request.budget ?? DEFAULT_BUDGET;
  const depth = request.depth ?? 1;

  switch (request.op) {
    case "overview": {
      const nodes = store.nodesInFile(request.arg).filter((n) => n.kind !== "file");
      if (nodes.length === 0) return notFound(`file ${request.arg}`, countTokens);

      const fitted = fitToBudget(nodes, budget, countTokens, `# ${request.arg}`);
      return { ...fitted, totalResults: nodes.length };
    }

    case "symbol": {
      const found = resolveSymbol(store, request.arg);
      if (found.length === 0) return notFound(`symbol ${request.arg}`, countTokens);

      const fitted = fitToBudget(found, budget, countTokens, `# symbol ${request.arg}`);
      return { ...fitted, totalResults: found.length };
    }

    case "references": {
      const targets = resolveSymbol(store, request.arg);
      if (targets.length === 0) return notFound(`symbol ${request.arg}`, countTokens);

      const seen = new Map<string, GraphNode>();
      for (const target of targets) {
        for (const caller of store.dependents({ id: target.id, kind: "calls", depth })) {
          seen.set(caller.id, caller);
        }
      }

      const nodes = [...seen.values()];
      if (nodes.length === 0) {
        const text = `${request.arg} has no recorded callers`;
        return { text, truncated: [], tokens: countTokens(text), totalResults: 0 };
      }

      const fitted = fitToBudget(nodes, budget, countTokens, `# callers of ${request.arg}`);
      return { ...fitted, totalResults: nodes.length };
    }

    case "dependencies": {
      const targets = resolveSymbol(store, request.arg);
      if (targets.length === 0) return notFound(`symbol ${request.arg}`, countTokens);

      const seen = new Map<string, GraphNode>();
      for (const target of targets) {
        for (const dep of store.neighbours({ id: target.id, kind: "calls", depth })) {
          seen.set(dep.id, dep);
        }
      }

      const nodes = [...seen.values()];
      const fitted = fitToBudget(nodes, budget, countTokens, `# called by ${request.arg}`);
      return { ...fitted, totalResults: nodes.length };
    }

    case "impact": {
      // What breaks if this changes: transitive callers, not just direct ones.
      // The router uses the size of this set to decide whether to escalate.
      const targets = resolveSymbol(store, request.arg);
      if (targets.length === 0) return notFound(`symbol ${request.arg}`, countTokens);

      const seen = new Map<string, GraphNode>();
      for (const target of targets) {
        for (const affected of store.dependents({
          id: target.id,
          depth: Math.max(depth, 3),
        })) {
          seen.set(affected.id, affected);
        }
      }

      const nodes = [...seen.values()];
      const files = new Set(nodes.map((n) => n.path));
      const header = `# impact of ${request.arg}: ${nodes.length} symbols across ${files.size} files`;
      const fitted = fitToBudget(nodes, budget, countTokens, header);
      return { ...fitted, totalResults: nodes.length };
    }

    case "tests_for": {
      const targets = resolveSymbol(store, request.arg);
      if (targets.length === 0) return notFound(`symbol ${request.arg}`, countTokens);

      const seen = new Map<string, GraphNode>();
      for (const target of targets) {
        for (const caller of store.dependents({ id: target.id, depth: 2 })) {
          // A test is any caller that lives in a test file.
          if (caller.kind === "test" || /\.(?:test|spec)\./.test(caller.path)) {
            seen.set(caller.id, caller);
          }
        }
      }

      const nodes = [...seen.values()];
      if (nodes.length === 0) {
        const text = `no tests found covering ${request.arg}`;
        return { text, truncated: [], tokens: countTokens(text), totalResults: 0 };
      }

      const fitted = fitToBudget(nodes, budget, countTokens, `# tests covering ${request.arg}`);
      return { ...fitted, totalResults: nodes.length };
    }

    case "search": {
      // Identifier matching. SPEC §4.2 allows degrading to this when no local
      // model is available for embeddings, and enrichment must never call cloud.
      const needle = request.arg.toLowerCase();
      const terms = needle.split(/\s+/).filter((t) => t.length > 1);

      const scored = store
        .findNodes({})
        .filter((n) => n.kind !== "file")
        .map((node) => {
          const haystack =
            `${node.name} ${node.signature ?? ""} ${node.docLine ?? ""}`.toLowerCase();
          const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
          return { node, score: node.name.toLowerCase() === needle ? score + 10 : score };
        })
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score);

      if (scored.length === 0) return notFound(`search "${request.arg}"`, countTokens);

      const nodes = scored.map((entry) => entry.node);
      const fitted = fitToBudget(nodes, budget, countTokens, `# search "${request.arg}"`);
      return { ...fitted, totalResults: nodes.length };
    }

    case "expand": {
      const node = store.getNode(request.arg);
      if (!node) return notFound(`id ${request.arg}`, countTokens);

      const text = renderNode(node);
      return { text, truncated: [], tokens: countTokens(text), totalResults: 1 };
    }

    default: {
      const text = `unknown operation: ${String(request.op)}`;
      return { text, truncated: [], tokens: countTokens(text), totalResults: 0 };
    }
  }
}
