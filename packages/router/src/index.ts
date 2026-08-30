/**
 * Model router (SPEC §4.5): layer selection across local / flash / escalation /
 * byok, provider fallbacks and budget accounting.
 *
 * Escalation share of tokens is a hard invariant (≤15%), not a target.
 */
export const PACKAGE = "router" as const;
