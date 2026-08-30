/**
 * Model router (SPEC §4.5): layer selection across local / flash / escalation /
 * byok, provider fallbacks and budget accounting.
 *
 * Escalation share of tokens is a hard invariant (≤15%), not a target.
 */
export type { Classification, ClassifyInput, TaskClass } from "./classifier.ts";
export { classify, IMPACT_ESCALATION_THRESHOLD } from "./classifier.ts";
export type { LayerPin, RouteDecision, RouterOptions } from "./router.ts";
export {
  ESCALATION_TOKEN_LIMIT,
  FAILURES_TO_ESCALATE,
  GREENS_TO_DE_ESCALATE,
  Router,
} from "./router.ts";

export const PACKAGE = "router" as const;
