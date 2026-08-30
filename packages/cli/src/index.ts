/**
 * CLI entry point (SPEC §4.1): interactive TUI, `--print`/`--json`, `--rpc`,
 * and the slash commands (`/cost`, `/model`, `/graph`, `/compact`, …).
 */
export type { CostReportOptions } from "./cost.ts";
export { costReport } from "./cost.ts";

export const PACKAGE = "cli" as const;
