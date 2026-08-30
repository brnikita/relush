/**
 * Agent loop and hook wiring (SPEC §4.1).
 *
 * Thin layer over `@earendil-works/pi-agent-core`: the context engine, history
 * manager and router all attach through its lifecycle hooks rather than
 * modifying the loop.
 */

export type { ComposedHooks } from "./compose.ts";
export { composeHooks } from "./compose.ts";
export type {
  Extension,
  HistoryStage,
  ToolGuard,
  ToolResultStage,
  TurnPlanner,
} from "./extensions.ts";

export const PACKAGE = "core" as const;

export { PINNED_INSTRUCTIONS, SYSTEM_PROMPT } from "./prompt.ts";
export type { ToolSchema } from "./tools.ts";
export {
  BASH_TOOL,
  CORE_TOOLS,
  EDIT_TOOL,
  GRAPH_QUERY_TOOL,
  READ_TOOL,
  WRITE_TOOL,
} from "./tools.ts";
