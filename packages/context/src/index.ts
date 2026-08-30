/**
 * Context engine (SPEC §4.3): budgeted `graph_query` retrieval and the
 * deterministic task map. Every response is token-budgeted and returns
 * compressed signatures, never bodies.
 */
export type { GraphOperation, GraphQueryRequest, GraphQueryResponse } from "./query.ts";
export { DEFAULT_BUDGET, fitToBudget, graphQuery, renderNode } from "./query.ts";

export type { RetrievalMiss } from "./retrieval-miss.ts";
export { pathsInResponse, RetrievalTracker } from "./retrieval-miss.ts";
export type { TaskMap, TaskMapOptions } from "./task-map.ts";
export { buildTaskMap, DEFAULT_TASK_MAP_BUDGET } from "./task-map.ts";
export type { GraphToolOptions, ToolResult } from "./tool.ts";
export { executeGraphQuery } from "./tool.ts";

export const PACKAGE = "context" as const;
