import { describe, expect, it } from "vitest";
import { handleMcpRequest, type McpRequest, parseMcpLine } from "./mcp.ts";
import { SqliteGraphStore } from "./sqlite-store.ts";

const store = () => {
  const s = new SqliteGraphStore({ path: ":memory:" });
  s.init();
  return s;
};

const execute = (args: Record<string, unknown>) => ({
  text: `ran ${String(args["op"])} on ${String(args["arg"])}`,
  isError: false,
});

const handle = (request: Partial<McpRequest> & { method: string }) =>
  handleMcpRequest({ jsonrpc: "2.0", id: 1, ...request } as McpRequest, {
    store: store(),
    execute,
  });

describe("parseMcpLine", () => {
  it("parses a valid request", () => {
    expect(parseMcpLine('{"jsonrpc":"2.0","id":1,"method":"ping"}')?.method).toBe("ping");
  });

  it.each([
    ["blank line", "   "],
    ["malformed json", "{not json"],
    ["wrong protocol", '{"jsonrpc":"1.0","method":"ping"}'],
    ["no method", '{"jsonrpc":"2.0","id":1}'],
  ])("rejects %s", (_label, line) => {
    expect(parseMcpLine(line)).toBeUndefined();
  });
});

describe("MCP protocol", () => {
  it("advertises tools on initialize", () => {
    const response = handle({ method: "initialize" });
    const result = response?.result as { capabilities: { tools: unknown } };

    expect(result.capabilities.tools).toBeDefined();
  });

  it("returns no response to a notification", () => {
    // Replying to a notification is a protocol error some clients treat as
    // fatal, so this has to be silent rather than merely harmless.
    expect(handle({ method: "notifications/initialized", id: undefined })).toBeUndefined();
  });

  it("lists graph_query with a schema", () => {
    const result = handle({ method: "tools/list" })?.result as {
      tools: { name: string; inputSchema: { required: string[] } }[];
    };

    expect(result.tools[0]?.name).toBe("graph_query");
    expect(result.tools[0]?.inputSchema.required).toEqual(["op", "arg"]);
  });

  it("executes a tool call", () => {
    const response = handle({
      method: "tools/call",
      params: { name: "graph_query", arguments: { op: "symbol", arg: "run" } },
    });
    const result = response?.result as { content: { text: string }[] };

    expect(result.content[0]?.text).toBe("ran symbol on run");
  });

  it("rejects an unknown tool name", () => {
    const response = handle({
      method: "tools/call",
      params: { name: "not_a_tool", arguments: {} },
    });

    expect(response?.error?.message).toMatch(/unknown tool/);
  });

  it("reports a tool failure as a result, not a protocol error", () => {
    // The model should see and recover from a bad argument, not have the call
    // rejected at the transport layer.
    const response = handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "graph_query", arguments: { op: "nonsense" } },
      },
      { store: store(), execute: () => ({ text: "unknown op", isError: true }) },
    );

    expect(response?.error).toBeUndefined();
    expect((response?.result as { isError: boolean }).isError).toBe(true);
  });

  it("answers ping", () => {
    expect(handle({ method: "ping" })?.result).toEqual({});
  });

  it("reports an unknown method with the standard code", () => {
    expect(handle({ method: "nope" })?.error?.code).toBe(-32601);
  });

  it("echoes the request id so a client can correlate", () => {
    expect(handle({ method: "ping", id: 42 })?.id).toBe(42);
  });
});
