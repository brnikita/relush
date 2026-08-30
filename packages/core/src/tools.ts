/**
 * The five core tool schemas (SPEC §4.1).
 *
 * Everything else is a lazily-loaded skill. This is not minimalism for its own
 * sake: filtering 29 tools down to a relevant subset cut description tokens by
 * 82% and selection errors by 89% (SPEC §1.1), so each tool kept here has to
 * earn its place on every request.
 *
 * Descriptions are written for a model, not a human reader. They say when to
 * reach for the tool and what it will refuse — the two things that actually
 * change behaviour — and omit anything derivable from the parameter schema.
 */

export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: {
    readonly type: "object";
    readonly properties: Record<string, unknown>;
    readonly required?: readonly string[];
  };
}

export const READ_TOOL: ToolSchema = {
  name: "read",
  description:
    "Read a file. Prefer graph_query first; reading a file it already covered is waste. Use offset/limit for large files.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or repo-relative path." },
      offset: { type: "integer", description: "First line to read, 1-indexed." },
      limit: { type: "integer", description: "Lines to read." },
    },
    required: ["path"],
  },
};

export const WRITE_TOOL: ToolSchema = {
  name: "write",
  description:
    "Create a file, or replace one in full. Overwriting a file you have not read is refused. For partial changes use edit.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
};

export const EDIT_TOOL: ToolSchema = {
  name: "edit",
  description:
    "Exact string replacement. old must appear exactly once unless all is true; otherwise the edit is refused.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      old: { type: "string", description: "Exact text to replace, including indentation." },
      new: { type: "string" },
      all: { type: "boolean", description: "Replace every occurrence." },
    },
    required: ["path", "old", "new"],
  },
};

export const BASH_TOOL: ToolSchema = {
  name: "bash",
  description:
    "Run a shell command. Non-interactive: it cannot answer prompts, so commands that wait for input will hang. Use for builds, tests, and git.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeoutMs: { type: "integer" },
    },
    required: ["command"],
  },
};

export const GRAPH_QUERY_TOOL: ToolSchema = {
  name: "graph_query",
  description:
    "Structural search over the indexed repository. Returns signatures, not bodies; oversized results are truncated to ids you can expand. Start here rather than reading files.",
  parameters: {
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
        description:
          "overview(path) | symbol(name) | references(name) | dependencies(name) | impact(diff) | tests_for(name) | search(query) | expand(id)",
      },
      arg: { type: "string", description: "Target of the operation." },
      depth: { type: "integer", description: "Traversal depth for symbol/dependencies." },
      budget: { type: "integer", description: "Max response tokens. Defaults to 4000." },
    },
    required: ["op", "arg"],
  },
};

/** The default tool set, present on every request (SPEC §4.1). */
export const CORE_TOOLS: readonly ToolSchema[] = [
  READ_TOOL,
  WRITE_TOOL,
  EDIT_TOOL,
  BASH_TOOL,
  GRAPH_QUERY_TOOL,
] as const;
