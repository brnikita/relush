/**
 * Local model runtime (SPEC §4.6): hardware detection and Ollama / llama.cpp /
 * MLX adapters. Unavailable local runtime degrades to the flash layer without
 * interrupting the session.
 */
export const PACKAGE = "local" as const;
