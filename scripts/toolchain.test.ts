import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * SPEC §0.5 mandates TypeScript strict mode for all work, and §0.7 forbids
 * disabling the budget check. Both are the kind of rule that erodes quietly
 * under deadline pressure, so they are asserted rather than trusted.
 */

/**
 * tsconfig files are JSONC, so line comments are stripped before parsing.
 * String literals are preserved, or a `//` inside a path would truncate the file.
 */
const readJsonc = (p: string): Record<string, unknown> => {
  const raw = readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  const stripped = raw.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) =>
    m.startsWith('"') ? m : "",
  );
  return JSON.parse(stripped);
};

describe("toolchain invariants", () => {
  it("keeps TypeScript strict mode and its companions on (SPEC §0.5)", () => {
    const base = readJsonc("tsconfig.base.json");
    const opts = base["compilerOptions"] as Record<string, unknown>;

    expect(opts["strict"]).toBe(true);
    // Strict alone still permits several classes of silent unsoundness.
    expect(opts["noUncheckedIndexedAccess"]).toBe(true);
    expect(opts["exactOptionalPropertyTypes"]).toBe(true);
    expect(opts["noImplicitOverride"]).toBe(true);
    expect(opts["noImplicitReturns"]).toBe(true);
  });

  it("targets a Node version the spec supports (SPEC §0.5: Node >= 22)", () => {
    const pkg = readJsonc("package.json");
    const engines = pkg["engines"] as Record<string, string>;
    const major = Number(/(\d+)/.exec(engines["node"] ?? "")?.[1]);

    expect(Number.isFinite(major)).toBe(true);
    expect(major).toBeGreaterThanOrEqual(22);
  });

  it("still defines the budget check script (SPEC §0.7: never disabled)", () => {
    const pkg = readJsonc("package.json");
    const scripts = pkg["scripts"] as Record<string, string>;

    expect(scripts["check:budgets"]).toBeTruthy();
  });
});
