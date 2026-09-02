import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { importRules } from "./import-config.ts";

const count = (t: string) => Math.ceil(t.length / 4);

const repo = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), "nodrel-import-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return root;
};

describe("importRules", () => {
  it("reads CLAUDE.md", () => {
    const r = importRules(repo({ "CLAUDE.md": "Use pnpm." }), count);
    expect(r.text).toContain("Use pnpm.");
    expect(r.sources[0]).toMatchObject({ tool: "claude", path: "CLAUDE.md" });
  });

  it("reads .cursorrules and .cursor/rules/*.mdc", () => {
    const r = importRules(
      repo({
        ".cursorrules": "Prefer named exports.",
        ".cursor/rules/style.mdc": "Two-space indent.",
      }),
      count,
    );
    expect(r.text).toContain("Prefer named exports.");
    expect(r.text).toContain("Two-space indent.");
    expect(r.sources.map((s) => s.tool)).toEqual(["cursor", "cursor"]);
  });

  it("reads AGENTS.md and .clinerules", () => {
    const r = importRules(repo({ "AGENTS.md": "codex rule", ".clinerules": "cline rule" }), count);
    expect(r.sources.map((s) => s.tool).sort()).toEqual(["cline", "codex"]);
  });

  it("drops duplicate content committed under two names", () => {
    // CLAUDE.md and AGENTS.md are often the same file; the model should not
    // pay for the same instructions twice.
    const r = importRules(repo({ "CLAUDE.md": "Same rules.", "AGENTS.md": "Same rules." }), count);
    expect(r.sources).toHaveLength(1);
  });

  it("labels each block with its origin", () => {
    const r = importRules(repo({ "CLAUDE.md": "x" }), count);
    expect(r.text).toContain("### from CLAUDE.md");
  });

  it("returns empty for a repository with no rules", () => {
    const r = importRules(repo({ "README.md": "not a rules file" }), count);
    expect(r.text).toBe("");
    expect(r.sources).toEqual([]);
    expect(r.tokensEstimate).toBe(0);
  });

  it("caps an oversized file rather than pinning a whole document", () => {
    const r = importRules(repo({ "CLAUDE.md": "x".repeat(100_000) }), count);
    expect(r.sources[0]?.bytes).toBeLessThanOrEqual(32 * 1024);
  });

  it("ignores non-rule files in a rules directory", () => {
    const r = importRules(
      repo({ ".claude/rules/a.md": "rule", ".claude/rules/settings.json": '{"x":1}' }),
      count,
    );
    expect(r.sources).toHaveLength(1);
  });

  it("never writes to the source directories", () => {
    const root = repo({ "CLAUDE.md": "x" });
    const before = JSON.stringify(require("node:fs").readdirSync(root));
    importRules(root, count);
    expect(JSON.stringify(require("node:fs").readdirSync(root))).toBe(before);
  });
});
