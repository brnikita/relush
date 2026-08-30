import { countTextTokens } from "@nodrel/ai";
import { graphQuery } from "@nodrel/context";
import type { LayerPin } from "@nodrel/router";
import { costReport } from "./cost.ts";
import type { Session } from "./session.ts";

/**
 * Slash commands (SPEC §4.1).
 *
 * Handled locally, never sent to a model. A command that costs a model call to
 * answer a question about cost would be self-defeating, and `/cost` in
 * particular has to be free or it changes the number it reports.
 */

export interface CommandContext {
  readonly session: Session;
  readonly telemetryPath: string;
  /** Last prompt, so `/graph` with no argument can use it. */
  readonly lastPrompt: string;
}

export interface CommandResult {
  readonly output: string;
  /** Set when the command ends the session. */
  readonly exit?: boolean;
}

export interface Command {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  run(args: string, context: CommandContext): Promise<CommandResult> | CommandResult;
}

const pinCommand = (name: string, pin: LayerPin, summary: string): Command => ({
  name,
  summary,
  usage: `/${name}`,
  run: (_args, { session }) => {
    session.setPin(pin);
    return { output: `layer pinned to ${pin}` };
  },
});

export const COMMANDS: readonly Command[] = [
  {
    name: "cost",
    summary: "Session and weekly spend, by layer",
    usage: "/cost",
    run: (_args, { session, telemetryPath }) => {
      const report = costReport({ telemetryPath, sessionId: session.id });
      const snapshot = session.router.snapshot();
      const invariant = snapshot.escalationShare <= 0.15 ? "within" : "OVER";

      return {
        output:
          `${report}\n\n` +
          `  layer        ${snapshot.layer}${snapshot.pinned === "auto" ? "" : ` (pinned)`}\n` +
          `  escalation   ${(snapshot.escalationShare * 100).toFixed(1)}% of tokens — ${invariant} the 15% limit`,
      };
    },
  },

  {
    name: "model",
    summary: "Show or pin the model layer",
    usage: "/model [local|flash|escalation|byok|auto]",
    run: (args, { session }) => {
      const target = args.trim();
      if (target === "") {
        const snapshot = session.router.snapshot();
        return {
          output: `layer: ${snapshot.layer}\npinned: ${snapshot.pinned}\nescalated: ${snapshot.escalated}`,
        };
      }

      const valid = ["local", "flash", "escalation", "byok", "auto"];
      if (!valid.includes(target)) {
        return { output: `unknown layer ${target}. Valid: ${valid.join(", ")}` };
      }

      session.setPin(target as LayerPin);
      return { output: `layer pinned to ${target}` };
    },
  },

  pinCommand("fast", "flash", "Pin the cheap layer"),
  pinCommand("strong", "escalation", "Pin the strong layer"),

  {
    name: "graph",
    summary: "Query the code graph",
    usage: "/graph <op> <arg>  |  /graph <symbol>",
    run: (args, { session }) => {
      const store = session.graphStore;
      if (!store) return { output: "no index — run /reindex first" };

      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) return { output: "usage: /graph <op> <arg>, or /graph <symbol>" };

      // One argument is the common case: treat it as a symbol lookup rather
      // than making the user remember an operation name.
      const [first, ...rest] = parts;
      const known = [
        "overview",
        "symbol",
        "references",
        "dependencies",
        "impact",
        "tests_for",
        "search",
        "expand",
      ];
      const op = known.includes(first ?? "") ? (first as string) : "symbol";
      const arg = known.includes(first ?? "") ? rest.join(" ") : parts.join(" ");

      if (arg === "") return { output: `usage: /graph ${op} <arg>` };

      const response = graphQuery(
        { op: op as never, arg },
        { store, countTokens: countTextTokens },
      );
      return { output: `${response.text}\n\n(${response.tokens} tokens)` };
    },
  },

  {
    name: "reindex",
    summary: "Rebuild the code graph",
    usage: "/reindex [--force]",
    run: async (args, { session }) => {
      const force = args.includes("--force");
      const result = await session.index(force);
      return {
        output:
          `indexed ${result.files} files in ${result.ms}ms\n` +
          `${result.nodes} symbols, ${result.edges} edges`,
      };
    },
  },

  {
    name: "expand",
    summary: "Retrieve compacted output by id",
    usage: "/expand <sha>",
    run: (args, { session }) => {
      const id = args.trim();
      if (id === "") return { output: "usage: /expand <sha>" };
      return { output: session.expand(id) };
    },
  },

  {
    name: "map",
    summary: "Show the task map for a prompt",
    usage: "/map [prompt]",
    run: (args, { session, lastPrompt }) => ({
      output: session.taskMap(args.trim() === "" ? lastPrompt : args),
    }),
  },

  {
    name: "compact",
    summary: "Force a compaction pass",
    usage: "/compact",
    run: (_args, { session }) => ({ output: session.compactNow() }),
  },

  {
    name: "clear",
    summary: "Start a fresh conversation, keeping the index",
    usage: "/clear",
    run: (_args, { session }) => {
      session.clear();
      return { output: "conversation cleared; the index is kept" };
    },
  },

  {
    name: "help",
    summary: "List commands",
    usage: "/help",
    run: () => ({
      output: COMMANDS.map((c) => `  ${c.usage.padEnd(38)} ${c.summary}`).join("\n"),
    }),
  },

  {
    name: "exit",
    summary: "End the session",
    usage: "/exit",
    run: () => ({ output: "", exit: true }),
  },
];

export const isCommand = (line: string): boolean => line.trimStart().startsWith("/");

/** Runs a slash command. Unknown names suggest `/help` rather than failing. */
export async function runCommand(line: string, context: CommandContext): Promise<CommandResult> {
  const trimmed = line.trim().slice(1);
  const spaceAt = trimmed.indexOf(" ");
  const name = (spaceAt === -1 ? trimmed : trimmed.slice(0, spaceAt)).toLowerCase();
  const args = spaceAt === -1 ? "" : trimmed.slice(spaceAt + 1);

  const command = COMMANDS.find((c) => c.name === name);
  if (!command) return { output: `unknown command /${name} — try /help` };

  return command.run(args, context);
}
