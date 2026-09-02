import type { GraphNode, GraphStore } from "@nodrel/graph";
import { renderNode } from "./query.ts";

/**
 * Deterministic task map (SPEC §4.3).
 *
 * Assembled once, before the first model call, and injected as pinned context.
 * Two properties are non-negotiable:
 *
 * 1. **No LLM call.** The map is what orients the model; producing it with a
 *    model call would spend tokens to save tokens.
 * 2. **Byte-stable for identical input.** It sits inside the cached prefix
 *    (SPEC §4.4), so any nondeterminism — map iteration order, a timestamp, an
 *    unsorted `Set` — invalidates the cache on every request of the session.
 *    Ordering here is therefore always explicit, never incidental.
 */

export interface TaskMapOptions {
  readonly store: GraphStore;
  readonly countTokens: (text: string) => number;
  /** The user's prompt, used to rank symbols. */
  readonly prompt: string;
  readonly budget?: number;
  /** Files listed in the repo map before symbols are considered. */
  readonly maxFiles?: number;
}

/**
 * Sized so that prompt + tools + pinned instructions + task map stays under the
 * SPEC §4.1 fixed-overhead ceiling of 2,000 tokens. The constant parts measure
 * 841 and imported project rules get 400, so 700 leaves ~60 tokens of slack.
 */
export const DEFAULT_TASK_MAP_BUDGET = 700;

/** Words worth matching on. Short tokens match everything and rank nothing. */
const termsOf = (prompt: string): string[] =>
  [...new Set(prompt.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) ?? [])].sort();

/**
 * Scores a symbol against the prompt.
 *
 * Exact name match dominates, then a name appearing as a substring, then doc
 * text. Files score lower than symbols because a path alone rarely answers a
 * question; it only orients.
 */
function score(node: GraphNode, terms: readonly string[]): number {
  const name = node.name.toLowerCase();
  const doc = (node.docLine ?? "").toLowerCase();
  const signature = (node.signature ?? "").toLowerCase();

  let total = 0;
  for (const term of terms) {
    if (name === term) total += 10;
    else if (name.includes(term)) total += 4;
    if (doc.includes(term)) total += 2;
    if (signature.includes(term)) total += 1;
  }
  return total;
}

export interface TaskMap {
  readonly text: string;
  readonly tokens: number;
  readonly symbolsIncluded: number;
}

/**
 * Builds the repo map plus the top-k symbols matching the prompt.
 *
 * Ties are broken by node id so the output cannot vary between runs on
 * identical input — the property the prefix cache depends on.
 */
export function buildTaskMap(options: TaskMapOptions): TaskMap {
  const budget = options.budget ?? DEFAULT_TASK_MAP_BUDGET;
  const maxFiles = options.maxFiles ?? 40;
  const terms = termsOf(options.prompt);

  const all = options.store.findNodes({});
  const files = all.filter((n) => n.kind === "file");
  const symbols = all.filter((n) => n.kind !== "file");

  const lines: string[] = ["# Repository map"];
  let tokens = options.countTokens(lines[0] as string);

  const filePaths = [...new Set(files.map((f) => f.path))].sort();
  for (const path of filePaths.slice(0, maxFiles)) {
    const line = `  ${path}`;
    const cost = options.countTokens(line) + 1;
    if (tokens + cost > budget / 2) break;
    lines.push(line);
    tokens += cost;
  }
  if (filePaths.length > maxFiles) {
    const note = `  … ${filePaths.length - maxFiles} more files`;
    lines.push(note);
    tokens += options.countTokens(note);
  }

  const ranked = symbols
    .map((node) => ({ node, value: score(node, terms) }))
    .filter((entry) => entry.value > 0)
    // Sort by score, then by id: an unstable order would change the bytes of
    // the pinned prefix between runs and cost every cache hit.
    .sort((a, b) => b.value - a.value || (a.node.id < b.node.id ? -1 : 1));

  let symbolsIncluded = 0;
  if (ranked.length > 0) {
    const header = "\n# Symbols matching this task";
    lines.push(header);
    tokens += options.countTokens(header);

    for (const entry of ranked) {
      const line = `  ${renderNode(entry.node)}`;
      const cost = options.countTokens(line) + 1;
      if (tokens + cost > budget) break;
      lines.push(line);
      tokens += cost;
      symbolsIncluded += 1;
    }
  }

  return { text: lines.join("\n"), tokens, symbolsIncluded };
}
