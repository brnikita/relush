/**
 * CLI entry point (SPEC §4.1): interactive TUI, `--print`/`--json`, `--rpc`,
 * and the slash commands (`/cost`, `/model`, `/graph`, `/compact`, …).
 */

export type { Command, CommandContext, CommandResult } from "./commands.ts";
export { COMMANDS, isCommand, runCommand } from "./commands.ts";
export type { CostReportOptions } from "./cost.ts";
export { costReport } from "./cost.ts";
export type { SessionOptions, TurnResult } from "./session.ts";
export { Session } from "./session.ts";

export const PACKAGE = "cli" as const;
