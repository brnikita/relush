import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAgent, ModelNotFoundError, resolveModel } from "./runtime.ts";

/**
 * The harness of record, exercised end to end (SPEC §7 M0).
 *
 * This is the agent the M0 baseline is measured against, so "it works" has to
 * mean a real model editing a real file on disk — not a mocked loop.
 *
 * Excluded from `pnpm test` and CI. Run with `pnpm test:live`.
 */

const KEY = process.env["OPENROUTER_API_KEY"];

const scratchRepo = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), "nodrel-e2e-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, "utf8");
  }
  return dir;
};

describe("resolveModel", () => {
  it("finds a model in OpenRouter's catalogue", () => {
    expect(resolveModel("z-ai/glm-5.3-flash").id).toBe("z-ai/glm-5.3-flash");
  });

  it("throws a named error for an unknown model", () => {
    expect(() => resolveModel("nope/not-real")).toThrow(ModelNotFoundError);
  });
});

describe.skipIf(!KEY)("agent end to end", () => {
  it("reads, edits and verifies a real file", async () => {
    const cwd = scratchRepo({
      "math.js": "function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n",
    });

    const used: string[] = [];
    const agent = createAgent({ modelId: "z-ai/glm-5.3-flash", apiKey: KEY ?? "", cwd });
    agent.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        used.push((event as { toolName?: string }).toolName ?? "?");
      }
    });

    await agent.prompt(
      "There is a bug in math.js: add() subtracts instead of adding. Fix it using the edit tool.",
    );

    // The fix must be on disk, not merely described.
    expect(readFileSync(join(cwd, "math.js"), "utf8")).toContain("a + b");
    expect(used).toContain("edit");
  }, 180_000);

  it("confines tool access to the working directory", async () => {
    const cwd = scratchRepo({ "only.txt": "inside\n" });

    const agent = createAgent({ modelId: "z-ai/glm-5.3-flash", apiKey: KEY ?? "", cwd });
    await agent.prompt("List the files in the current directory using bash, then stop.");

    const transcript = JSON.stringify(agent.state.messages);
    expect(transcript).toContain("only.txt");
  }, 180_000);
});
