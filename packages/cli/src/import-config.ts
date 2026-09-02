import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Read-only import of project rules from other agents' config directories
 * (SPEC §4.1). A user switching from Claude Code or Cursor has already written
 * down how their repository works; making them do it again is friction for no
 * gain.
 *
 * Read-only is a hard rule: these directories belong to other tools, and a
 * write here would show up as an unexplained diff in someone else's workflow.
 */

export interface ImportedRules {
  /** Which tool each block came from, for the user's information. */
  readonly sources: readonly { tool: string; path: string; bytes: number }[];
  /** Concatenated rule text, ready to append to pinned context. */
  readonly text: string;
  readonly tokensEstimate: number;
}

interface Source {
  readonly tool: string;
  /** Candidate files, relative to the repo root, in priority order. */
  readonly files: readonly string[];
  /** Directories whose `*.md` files are all rules. */
  readonly dirs: readonly string[];
}

const SOURCES: readonly Source[] = [
  { tool: "claude", files: ["CLAUDE.md", ".claude/CLAUDE.md"], dirs: [".claude/rules"] },
  { tool: "cursor", files: [".cursorrules"], dirs: [".cursor/rules"] },
  { tool: "codex", files: ["AGENTS.md", ".codex/AGENTS.md"], dirs: [] },
  { tool: "cline", files: [".clinerules"], dirs: [".clinerules.d"] },
];

/** Per-file cap. Rules longer than this are a document, not a rule set. */
const MAX_FILE_BYTES = 32 * 1024;

const readIfFile = (path: string): string | undefined => {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return undefined;
    const text = readFileSync(path, "utf8");
    return text.length > MAX_FILE_BYTES ? text.slice(0, MAX_FILE_BYTES) : text;
  } catch {
    return undefined;
  }
};

/**
 * Collects rules from every recognized source under `root`.
 *
 * Duplicates are common — the same content committed as both `CLAUDE.md` and
 * `AGENTS.md` — and are dropped by content, so the model does not read the
 * same instructions twice at the cost of the same tokens twice.
 */
export function importRules(root: string, countTokens: (text: string) => number): ImportedRules {
  const sources: { tool: string; path: string; bytes: number }[] = [];
  const blocks: string[] = [];
  const seen = new Set<string>();

  const add = (tool: string, relative: string, text: string): void => {
    const trimmed = text.trim();
    if (trimmed === "" || seen.has(trimmed)) return;
    seen.add(trimmed);
    sources.push({ tool, path: relative, bytes: Buffer.byteLength(trimmed, "utf8") });
    blocks.push(`### from ${relative}\n${trimmed}`);
  };

  for (const source of SOURCES) {
    for (const file of source.files) {
      const text = readIfFile(join(root, file));
      if (text !== undefined) add(source.tool, file, text);
    }
    for (const dir of source.dirs) {
      const full = join(root, dir);
      if (!existsSync(full)) continue;
      let entries: string[];
      try {
        entries = readdirSync(full)
          .filter((name) => /\.(?:md|mdc|txt)$/i.test(name))
          .sort();
      } catch {
        continue;
      }
      for (const name of entries) {
        const text = readIfFile(join(full, name));
        if (text !== undefined) add(source.tool, `${dir}/${name}`, text);
      }
    }
  }

  const text = blocks.length === 0 ? "" : `## Project rules (imported)\n\n${blocks.join("\n\n")}`;
  return { sources, text, tokensEstimate: countTokens(text) };
}
