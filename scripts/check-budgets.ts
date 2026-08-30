/**
 * Enforces the fixed-overhead token budgets from SPEC §4.1:
 *   - core system prompt      <=   800 tokens
 *   - total fixed overhead    <= 2,000 tokens (prompt + core tool schemas +
 *                                pinned instructions)
 *
 * SPEC §0.7: this check must never be disabled. It is wired into CI and
 * asserted by scripts/toolchain.test.ts.
 *
 * STUB (F4): the real implementation lands in F7, once the tokenizer and the
 * system prompt exist. It exits 0 today so CI is green, and prints its
 * placeholder status rather than pretending to have measured anything.
 */

const BUDGETS = {
  systemPrompt: 800,
  fixedOverhead: 2000,
} as const;

function main(): number {
  console.log("check:budgets — SPEC §4.1");
  console.log(`  system prompt budget:   ${BUDGETS.systemPrompt} tokens`);
  console.log(`  fixed overhead budget:  ${BUDGETS.fixedOverhead} tokens`);
  console.log("  status: NOT YET MEASURED (stub; real check lands in F7)");
  return 0;
}

process.exit(main());
