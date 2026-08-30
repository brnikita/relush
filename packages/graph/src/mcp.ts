import type { GraphStore } from "./types.ts";

/**
 * The code graph as an MCP server (SPEC §4.2, secondary distribution).
 *
 * Same query API as `graph_query`, exposed over JSON-RPC on stdio so another
 * agent can use the index without adopting nodrel. This is the "graph as a
 * product" path: the index is the expensive artefact, and nothing about it is
 * specific to this harness.
 *
 * Implemented against the wire protocol directly rather than through an SDK,
 * because MCP over stdio is a small protocol and a dependency here would be the
 * only one in `@nodrel/graph` (ADR-001's no-native-dependency property is about
 * portability, but dependency count is the same discipline).
 */

export interface McpRequest {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface McpResponse {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: { code: number; message: string };
}

const PROTOCOL_VERSION = "2025-06-18";

/** JSON-RPC error codes used here. */
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

const TOOL_DEFINITION = {
  name: "graph_query",
  description: "Structural search over an indexed repository. Returns signatures, not bodies.",
  inputSchema: {
    type: "object",
    properties: {
      op: {
        type: "string",
        enum: [
          "overview",
          "symbol",
          "references",
          "dependencies",
          "impact",
          "tests_for",
          "search",
          "expand",
        ],
      },
      arg: { type: "string" },
      depth: { type: "integer" },
      budget: { type: "integer" },
    },
    required: ["op", "arg"],
  },
} as const;

export interface McpServerOptions {
  readonly store: GraphStore;
  /** Injected so the server does not depend on `@nodrel/context`. */
  readonly execute: (args: Record<string, unknown>) => { text: string; isError: boolean };
}

/**
 * Handles one MCP request.
 *
 * Notifications (no `id`) get no response, per JSON-RPC: replying to one is a
 * protocol error that some clients treat as fatal.
 */
export function handleMcpRequest(
  request: McpRequest,
  options: McpServerOptions,
): McpResponse | undefined {
  const id = request.id ?? null;

  const reply = (result: unknown): McpResponse => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string): McpResponse => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });

  switch (request.method) {
    case "initialize":
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "nodrel-graph", version: "0.1.0" },
      });

    case "notifications/initialized":
      // A notification: no id, no response.
      return undefined;

    case "tools/list":
      return reply({ tools: [TOOL_DEFINITION] });

    case "tools/call": {
      const params = request.params ?? {};
      if (params["name"] !== TOOL_DEFINITION.name) {
        return fail(INVALID_PARAMS, `unknown tool: ${String(params["name"])}`);
      }

      const args = (params["arguments"] ?? {}) as Record<string, unknown>;
      const result = options.execute(args);

      // A tool-level failure is a result with `isError`, not a JSON-RPC error:
      // the model should see and recover from it, not have the call rejected.
      return reply({
        content: [{ type: "text", text: result.text }],
        isError: result.isError,
      });
    }

    case "ping":
      return reply({});

    default:
      return fail(METHOD_NOT_FOUND, `unknown method: ${request.method}`);
  }
}

/** Parses a line as an MCP request, or returns undefined. */
export function parseMcpLine(line: string): McpRequest | undefined {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;

  try {
    const parsed = JSON.parse(trimmed) as McpRequest;
    return parsed.jsonrpc === "2.0" && typeof parsed.method === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}
