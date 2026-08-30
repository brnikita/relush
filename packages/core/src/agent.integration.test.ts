import { Agent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { composeHooks } from "./compose.ts";
import type { Extension } from "./extensions.ts";

/**
 * Proves the depend-and-extend decision actually holds: composed hooks reach
 * Pi's real agent loop, not a mock of it.
 *
 * The provider is stubbed — F8 wires a live one — but the `Agent` and its loop
 * are genuine, which is the part that would fail if our hook wiring were wrong.
 */

const assistantMessage = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-completions",
  provider: "test" as AssistantMessage["provider"],
  model: "stub",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  } as AssistantMessage["usage"],
  stopReason: "stop",
  timestamp: Date.now(),
});

/** A provider that answers once with fixed text and never calls a tool. */
const stubStreamFn = (_model: Model<never>, _context: Context) => {
  const stream = createAssistantMessageEventStream();
  const message = assistantMessage("ack");
  queueMicrotask(() => {
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
  });
  return stream;
};

const stubModel = {
  id: "stub",
  api: "openai-completions",
  provider: "test",
} as unknown as Model<never>;

describe("agent integration", () => {
  it("runs a turn through Pi's loop with composed hooks attached", async () => {
    const seen: string[] = [];

    const recording: Extension = {
      name: "recording",
      historyStages: [
        {
          name: "observe",
          transform: async (messages) => {
            seen.push(`transformContext:${messages.length}`);
            return messages;
          },
        },
      ],
      turnPlanners: [
        {
          name: "observe",
          plan: async () => {
            seen.push("prepareNextTurn");
            return undefined;
          },
        },
      ],
    };

    const hooks = composeHooks([recording]);
    const agent = new Agent({
      streamFn: stubStreamFn as never,
      initialState: { model: stubModel } as never,
      transformContext: hooks.transformContext,
      beforeToolCall: hooks.beforeToolCall,
      afterToolCall: hooks.afterToolCall,
      prepareNextTurnWithContext: hooks.prepareNextTurnWithContext,
    });

    await agent.prompt("hello");

    // transformContext is the history manager's attachment point; if it never
    // fires, masking and prefix pinning have nowhere to live.
    expect(seen).toContain("transformContext:1");

    const messages = agent.state.messages as { role: string }[];
    expect(messages.at(-1)?.role).toBe("assistant");
  });

  it("lets a history stage rewrite what the provider receives", async () => {
    let received: Context | undefined;

    const capturingStreamFn = (_model: Model<never>, context: Context) => {
      received = context;
      return stubStreamFn(_model, context);
    };

    const rewriting: Extension = {
      name: "rewriting",
      historyStages: [
        {
          name: "redact",
          transform: async (messages) =>
            messages.map((m) => {
              const content = (m as unknown as { content: unknown }).content;
              if (!Array.isArray(content)) return m;
              return {
                ...m,
                content: content.map((c: { type?: string; text?: string }) =>
                  c.type === "text" ? { ...c, text: "[redacted]" } : c,
                ),
              } as typeof m;
            }),
        },
      ],
    };

    const hooks = composeHooks([rewriting]);
    const agent = new Agent({
      streamFn: capturingStreamFn as never,
      initialState: { model: stubModel } as never,
      transformContext: hooks.transformContext,
    });

    await agent.prompt("sensitive original text");

    // This is the mechanism masking and compression depend on: what the stage
    // returns is what the provider sees.
    const sent = JSON.stringify(received?.messages ?? []);
    expect(sent).toContain("[redacted]");
    expect(sent).not.toContain("sensitive original text");
  });
});
