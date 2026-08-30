import { countTextTokens } from "@nodrel/ai";
import { executeGraphQuery } from "@nodrel/context";
import type { GraphStore } from "@nodrel/graph";
import { GRAPH_QUERY_TOOL } from "./tools.ts";

/**
 * Registers `graph_query` with the agent (SPEC §4.1).
 *
 * Shape matches Pi's `AgentTool`: the loop calls `execute` with the tool call
 * id and parsed arguments, and expects content back rather than a thrown error.
 */

export interface GraphToolDeps {
  readonly store: GraphStore;
  readonly onQuery?: (event: {
    op: string;
    arg: string;
    tokens: number;
    results: number;
    truncated: number;
  }) => void;
}

export function createGraphQueryTool(deps: GraphToolDeps): unknown {
  return {
    name: GRAPH_QUERY_TOOL.name,
    label: "Graph query",
    description: GRAPH_QUERY_TOOL.description,
    parameters: GRAPH_QUERY_TOOL.parameters,
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const result = executeGraphQuery(params, {
        store: deps.store,
        countTokens: countTextTokens,
        ...(deps.onQuery === undefined ? {} : { onQuery: deps.onQuery }),
      });
      return { content: result.content, isError: result.isError };
    },
  };
}
