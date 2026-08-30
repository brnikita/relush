import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { composeHooks } from "./compose.ts";
import type { Extension, HistoryStage, ToolGuard, TurnPlanner } from "./extensions.ts";

/** Minimal message stand-in; only the shape the stages touch is relevant here. */
const msg = (text: string): AgentMessage =>
  ({ role: "user", content: [{ type: "text", text }] }) as unknown as AgentMessage;

const textOf = (m: AgentMessage): string =>
  (m as unknown as { content: { text: string }[] }).content[0]?.text ?? "";

/** A history stage that appends a marker, so ordering is observable. */
const marking = (name: string): HistoryStage => ({
  name,
  transform: async (messages) => messages.map((m) => msg(`${textOf(m)}>${name}`)),
});

const guard = (
  name: string,
  verdict: { block?: boolean; reason?: string } | undefined,
): ToolGuard => ({
  name,
  check: async () => verdict,
});

const planner = (name: string, update: Record<string, unknown> | undefined): TurnPlanner => ({
  name,
  plan: async () => update as never,
});

const ext = (name: string, parts: Omit<Extension, "name">): Extension => ({ name, ...parts });

describe("composeHooks", () => {
  describe("history stages", () => {
    it("pipes each stage's output into the next, in registration order", async () => {
      const hooks = composeHooks([
        ext("a", { historyStages: [marking("mask")] }),
        ext("b", { historyStages: [marking("pin")] }),
      ]);

      const out = await hooks.transformContext([msg("raw")]);

      // Order is part of the contract: masking must precede prefix pinning, or
      // the pinned bytes shift and the provider cache misses.
      expect(textOf(out[0] as AgentMessage)).toBe("raw>mask>pin");
    });

    it("returns the input untouched when no stages are registered", async () => {
      const hooks = composeHooks([]);
      const input = [msg("raw")];

      await expect(hooks.transformContext(input)).resolves.toEqual(input);
    });
  });

  describe("tool guards", () => {
    it("short-circuits on the first blocking verdict", async () => {
      let secondConsulted = false;
      const hooks = composeHooks([
        ext("a", { toolGuards: [guard("deny", { block: true, reason: "nope" })] }),
        ext("b", {
          toolGuards: [
            {
              name: "never",
              check: async () => {
                secondConsulted = true;
                return undefined;
              },
            },
          ],
        }),
      ]);

      const verdict = await hooks.beforeToolCall({} as never);

      expect(verdict).toEqual({ block: true, reason: "nope" });
      expect(secondConsulted).toBe(false);
    });

    it("treats a non-blocking verdict as an abstention and keeps asking", async () => {
      const hooks = composeHooks([
        ext("a", { toolGuards: [guard("abstain", undefined)] }),
        ext("b", { toolGuards: [guard("allow", { block: false })] }),
        ext("c", { toolGuards: [guard("deny", { block: true, reason: "last" })] }),
      ]);

      await expect(hooks.beforeToolCall({} as never)).resolves.toEqual({
        block: true,
        reason: "last",
      });
    });
  });

  describe("turn planners", () => {
    it("lets the last planner win, so an explicit pin overrides the router", async () => {
      const hooks = composeHooks([
        ext("router", { turnPlanners: [planner("auto", { model: "flash" })] }),
        ext("cli", { turnPlanners: [planner("pin", { model: "escalation" })] }),
      ]);

      await expect(hooks.prepareNextTurnWithContext({} as never)).resolves.toEqual({
        model: "escalation",
      });
    });

    it("merges disjoint fields rather than discarding them", async () => {
      const hooks = composeHooks([
        ext("router", { turnPlanners: [planner("auto", { model: "flash" })] }),
        ext("cli", { turnPlanners: [planner("think", { thinkingLevel: "high" })] }),
      ]);

      await expect(hooks.prepareNextTurnWithContext({} as never)).resolves.toEqual({
        model: "flash",
        thinkingLevel: "high",
      });
    });

    it("returns undefined when every planner abstains", async () => {
      const hooks = composeHooks([ext("router", { turnPlanners: [planner("auto", undefined)] })]);

      await expect(hooks.prepareNextTurnWithContext({} as never)).resolves.toBeUndefined();
    });
  });

  describe("tool result stages", () => {
    it("shows each stage the previous stage's output, not the raw result", async () => {
      const seen: string[] = [];
      const hooks = composeHooks([
        ext("a", {
          toolResultStages: [
            {
              name: "first",
              process: async (ctx) => {
                seen.push((ctx as unknown as { marker?: string }).marker ?? "raw");
                return { details: "compressed-once" };
              },
            },
          ],
        }),
        ext("b", {
          toolResultStages: [
            {
              name: "second",
              process: async (ctx) => {
                seen.push((ctx as unknown as { details?: string }).details ?? "raw");
                return { details: "compressed-twice" };
              },
            },
          ],
        }),
      ]);

      const result = await hooks.afterToolCall({ marker: "raw" } as never);

      expect(seen).toEqual(["raw", "compressed-once"]);
      expect(result).toEqual({ details: "compressed-twice" });
    });

    it("returns undefined when no stage overrides, leaving the result untouched", async () => {
      const hooks = composeHooks([]);

      await expect(hooks.afterToolCall({} as never)).resolves.toBeUndefined();
    });
  });
});
