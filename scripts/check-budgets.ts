import { countTextTokens, estimateToolTokens } from "@nodrel/ai";
import { CORE_TOOLS, PINNED_INSTRUCTIONS, SYSTEM_PROMPT } from "@nodrel/core";

/**
 * Enforces the fixed-overhead token budgets from SPEC §4.1:
 *
 *   - core system prompt   ≤   800 tokens
 *   - total fixed overhead ≤ 2,000 tokens
 *
 * "Fixed overhead" is what every request pays before any conversation content:
 * system prompt + core tool schemas + pinned instructions.
 *
 * SPEC §0.7: this check must never be disabled or weakened to make a commit
 * pass. If it fails, the fix is a smaller prompt or a tool moved to a lazy
 * skill — never a raised ceiling. `scripts/toolchain.test.ts` asserts the
 * script stays wired up.
 */

const SYSTEM_PROMPT_BUDGET = 800;
const FIXED_OVERHEAD_BUDGET = 2000;

interface Line {
  readonly label: string;
  readonly tokens: number;
}

const bar = (tokens: number, budget: number, width = 24): string => {
  const filled = Math.min(width, Math.round((tokens / budget) * width));
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
};

const pct = (tokens: number, budget: number): string => `${((tokens / budget) * 100).toFixed(1)}%`;

function main(): number {
  const systemPromptTokens = countTextTokens(SYSTEM_PROMPT);
  const pinnedTokens = countTextTokens(PINNED_INSTRUCTIONS);

  const toolLines: Line[] = CORE_TOOLS.map((tool) => ({
    label: `  tool: ${tool.name}`,
    tokens: estimateToolTokens(tool),
  }));
  const toolTokens = toolLines.reduce((sum, line) => sum + line.tokens, 0);

  const fixedOverhead = systemPromptTokens + toolTokens + pinnedTokens;

  console.log("check:budgets — SPEC §4.1\n");

  const width = Math.max(...toolLines.map((l) => l.label.length), 22);
  const row = (label: string, tokens: number): void =>
    console.log(`  ${label.padEnd(width)}  ${String(tokens).padStart(5)}`);

  row("system prompt", systemPromptTokens);
  for (const line of toolLines) row(line.label.trim(), line.tokens);
  row("core tools (total)", toolTokens);
  row("pinned instructions", pinnedTokens);
  console.log(`  ${"─".repeat(width + 8)}`);
  row("fixed overhead", fixedOverhead);

  console.log("");
  console.log(
    `  system prompt   ${bar(systemPromptTokens, SYSTEM_PROMPT_BUDGET)} ` +
      `${systemPromptTokens}/${SYSTEM_PROMPT_BUDGET} (${pct(systemPromptTokens, SYSTEM_PROMPT_BUDGET)})`,
  );
  console.log(
    `  fixed overhead  ${bar(fixedOverhead, FIXED_OVERHEAD_BUDGET)} ` +
      `${fixedOverhead}/${FIXED_OVERHEAD_BUDGET} (${pct(fixedOverhead, FIXED_OVERHEAD_BUDGET)})`,
  );
  console.log("");

  const failures: string[] = [];
  if (systemPromptTokens > SYSTEM_PROMPT_BUDGET) {
    failures.push(
      `system prompt is ${systemPromptTokens} tokens, over the ${SYSTEM_PROMPT_BUDGET} budget by ${systemPromptTokens - SYSTEM_PROMPT_BUDGET}`,
    );
  }
  if (fixedOverhead > FIXED_OVERHEAD_BUDGET) {
    failures.push(
      `fixed overhead is ${fixedOverhead} tokens, over the ${FIXED_OVERHEAD_BUDGET} budget by ${fixedOverhead - FIXED_OVERHEAD_BUDGET}`,
    );
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`  FAIL: ${failure}`);
    console.error(
      "\n  Shrink the prompt or move a tool to a lazy skill (SPEC §4.7).\n" +
        "  Do not raise the budget — SPEC §0.7 forbids disabling this check.",
    );
    return 1;
  }

  console.log("  PASS — within SPEC §4.1 budgets");
  return 0;
}

process.exit(main());
