/**
 * Agent loop and hook wiring (SPEC §4.1).
 *
 * Thin layer over `@earendil-works/pi-agent-core`: the context engine, history
 * manager and router all attach through its lifecycle hooks rather than
 * modifying the loop.
 */
export const PACKAGE = "core" as const;
