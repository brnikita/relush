import { countTextTokens, estimateToolTokens } from "@nodrel/ai";
import { describe, expect, it } from "vitest";
import { PINNED_INSTRUCTIONS, SYSTEM_PROMPT } from "./prompt.ts";
import { CORE_TOOLS } from "./tools.ts";

/**
 * SPEC §4.1's budgets, asserted in the unit suite as well as in
 * `pnpm check:budgets`.
 *
 * The script is the CI gate; these tests make a breach fail during ordinary
 * development, at the moment the prompt is edited, rather than at push time.
 */

const SYSTEM_PROMPT_BUDGET = 800;
const FIXED_OVERHEAD_BUDGET = 2000;

const toolTokens = () => CORE_TOOLS.reduce((sum, tool) => sum + estimateToolTokens(tool), 0);

const fixedOverhead = () =>
  countTextTokens(SYSTEM_PROMPT) + toolTokens() + countTextTokens(PINNED_INSTRUCTIONS);

describe("fixed overhead budgets (SPEC §4.1)", () => {
  it("keeps the system prompt under 800 tokens", () => {
    const tokens = countTextTokens(SYSTEM_PROMPT);

    expect(tokens, `system prompt is ${tokens} tokens`).toBeLessThanOrEqual(SYSTEM_PROMPT_BUDGET);
  });

  it("keeps total fixed overhead under 2000 tokens", () => {
    const tokens = fixedOverhead();

    expect(tokens, `fixed overhead is ${tokens} tokens`).toBeLessThanOrEqual(FIXED_OVERHEAD_BUDGET);
  });

  it("ships exactly the five core tools the spec names", () => {
    // Anything beyond these five belongs in a lazily-loaded skill (SPEC §4.7);
    // adding a sixth here taxes every request of every session.
    expect(CORE_TOOLS.map((t) => t.name).sort()).toEqual([
      "bash",
      "edit",
      "graph_query",
      "read",
      "write",
    ]);
  });

  it("leaves real headroom rather than sitting at the ceiling", () => {
    // A budget met at 99% breaks on the next word added. This asserts the
    // design goal, not just the hard limit.
    expect(fixedOverhead()).toBeLessThan(FIXED_OVERHEAD_BUDGET * 0.75);
  });
});

describe("tool schemas", () => {
  it("gives every tool a name, a description and an object parameter schema", () => {
    for (const tool of CORE_TOOLS) {
      expect(tool.name, "name").toBeTruthy();
      expect(tool.description.length, `${tool.name} description`).toBeGreaterThan(20);
      expect(tool.parameters.type, `${tool.name} parameters`).toBe("object");
    }
  });

  it("marks every declared required parameter as an actual property", () => {
    for (const tool of CORE_TOOLS) {
      for (const key of tool.parameters.required ?? []) {
        expect(tool.parameters.properties, `${tool.name}.${key}`).toHaveProperty(key);
      }
    }
  });

  it("points the model at graph_query before read, per SPEC §4.3", () => {
    // The token thesis collapses if the model reads files by default.
    const read = CORE_TOOLS.find((t) => t.name === "read");

    expect(read?.description).toMatch(/graph_query/);
  });
});

describe("system prompt content", () => {
  it("instructs terse output, which SPEC §4.1 targets at -40% output tokens", () => {
    expect(SYSTEM_PROMPT).toMatch(/terse/i);
    expect(SYSTEM_PROMPT).toMatch(/three sentences/i);
  });

  it("names every core tool, so none is invisible to the model", () => {
    for (const tool of CORE_TOOLS) {
      expect(SYSTEM_PROMPT, tool.name).toMatch(new RegExp(`\\b${tool.name}\\b`));
    }
  });
});
