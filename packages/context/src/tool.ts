import type { GraphStore } from "@nodrel/graph";
import { type GraphOperation, graphQuery } from "./query.ts";
import { pathsInResponse } from "./retrieval-miss.ts";

/**
 * `graph_query` as an agent tool (SPEC §4.1, §4.3).
 *
 * The tool is deliberately one entry point with an `op` parameter rather than
 * eight separate tools. Eight would cost eight descriptions on every request,
 * against a 2,000-token fixed-overhead budget, and SPEC §1.1's evidence is that
 * more tool descriptions also raise selection errors.
 */

export interface GraphToolOptions {
  readonly store: GraphStore;
  readonly countTokens: (text: string) => number;
  /** Notified per call, for retrieval-miss analysis (SPEC §4.3). */
  readonly onQuery?: (event: {
    op: string;
    arg: string;
    tokens: number;
    results: number;
    truncated: number;
    /** Files the response referred to, for retrieval-miss tracking. */
    paths: readonly string[];
  }) => void;
}

export interface ToolResult {
  readonly content: readonly { type: "text"; text: string }[];
  readonly isError: boolean;
}

const OPERATIONS: readonly GraphOperation[] = [
  "overview",
  "symbol",
  "references",
  "dependencies",
  "impact",
  "tests_for",
  "search",
  "expand",
];

const isOperation = (value: unknown): value is GraphOperation =>
  typeof value === "string" && (OPERATIONS as readonly string[]).includes(value);

/**
 * Executes a `graph_query` tool call.
 *
 * Invalid arguments produce a tool error naming the valid operations rather
 * than an exception: the model recovers from a readable error in one turn, and
 * a thrown exception ends the session.
 */
export function executeGraphQuery(
  args: { op?: unknown; arg?: unknown; depth?: unknown; budget?: unknown },
  options: GraphToolOptions,
): ToolResult {
  if (!isOperation(args.op)) {
    return {
      content: [
        {
          type: "text",
          text: `unknown op ${JSON.stringify(args.op)}. Valid: ${OPERATIONS.join(", ")}`,
        },
      ],
      isError: true,
    };
  }

  if (typeof args.arg !== "string" || args.arg === "") {
    return {
      content: [{ type: "text", text: `op ${args.op} requires a non-empty "arg"` }],
      isError: true,
    };
  }

  const response = graphQuery(
    {
      op: args.op,
      arg: args.arg,
      ...(typeof args.depth === "number" ? { depth: args.depth } : {}),
      ...(typeof args.budget === "number" ? { budget: args.budget } : {}),
    },
    { store: options.store, countTokens: options.countTokens },
  );

  options.onQuery?.({
    op: args.op,
    arg: args.arg,
    tokens: response.tokens,
    results: response.totalResults,
    truncated: response.truncated.length,
    paths: pathsInResponse(response.text),
  });

  return { content: [{ type: "text", text: response.text }], isError: false };
}
