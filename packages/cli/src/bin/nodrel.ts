#!/usr/bin/env node
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { isCommand, runCommand } from "../commands.ts";
import { Session } from "../session.ts";

/**
 * `nodrel` — the CLI entry point (SPEC §4.1).
 *
 * Three modes: `--print` for one prompt and out, `--json` for machine-readable
 * output, and an interactive REPL by default.
 */

interface Options {
  readonly prompt: string | undefined;
  readonly print: boolean;
  readonly json: boolean;
  readonly cwd: string;
  readonly model: string | undefined;
  readonly graph: boolean;
  readonly history: boolean;
  readonly help: boolean;
  readonly version: boolean;
}

const VERSION = "0.1.0";

const USAGE = `nodrel ${VERSION} — a token-optimized coding agent

Usage:
  nodrel                          interactive session
  nodrel --print "<prompt>"       run one prompt and exit
  nodrel --json "<prompt>"        same, as JSON

Options:
  -p, --print <prompt>   Run one prompt and print the answer
      --json <prompt>    Run one prompt and print a JSON result
  -C, --cwd <dir>        Working directory (default: current)
  -m, --model <id>       Model id (default: z-ai/glm-5.3-flash)
      --no-graph         Disable the code graph (on by default)
      --history          Enable batched history compaction
  -h, --help             Show this message
  -v, --version          Show the version

Environment:
  OPENROUTER_API_KEY     Required.

In a session, /help lists the slash commands.`;

function parseArgs(argv: readonly string[]): Options {
  const value = (...flags: string[]): string | undefined => {
    for (const flag of flags) {
      const index = argv.indexOf(flag);
      if (index !== -1) return argv[index + 1];
    }
    return undefined;
  };
  const has = (...flags: string[]): boolean => flags.some((flag) => argv.includes(flag));

  const print = has("-p", "--print");
  const json = has("--json");

  return {
    prompt: print ? value("-p", "--print") : json ? value("--json") : undefined,
    print,
    json,
    cwd: value("-C", "--cwd") ?? process.cwd(),
    model: value("-m", "--model"),
    // The graph is the point of the tool, so it is on unless refused.
    graph: !has("--no-graph"),
    history: has("--history"),
    help: has("-h", "--help"),
    version: has("-v", "--version"),
  };
}

const usd = (n: number): string => (n < 0.01 ? `$${n.toFixed(5)}` : `$${n.toFixed(4)}`);

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (options.version) {
    console.log(VERSION);
    return 0;
  }

  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) {
    console.error("OPENROUTER_API_KEY is not set.");
    return 2;
  }

  const telemetryPath = join(options.cwd, ".agent", "telemetry.jsonl");
  const session = new Session({
    cwd: options.cwd,
    apiKey,
    ...(options.model === undefined ? {} : { modelId: options.model }),
    graph: options.graph,
    history: options.history,
    telemetryPath,
  });

  try {
    // Single-shot modes.
    if (options.print || options.json) {
      if (!options.prompt) {
        console.error("--print and --json require a prompt");
        return 2;
      }

      const result = await session.prompt(options.prompt);

      if (options.json) {
        console.log(
          JSON.stringify({
            text: result.text,
            toolCalls: result.toolCalls,
            tokens: result.tokens,
            costUsd: result.costUsd,
            layer: result.layer,
            sessionId: session.id,
          }),
        );
      } else {
        console.log(result.text);
      }
      return 0;
    }

    // Interactive.
    console.log(`nodrel ${VERSION}  ·  ${options.cwd}`);
    if (options.graph) {
      const indexed = await session.index();
      console.log(`indexed ${indexed.files} files, ${indexed.nodes} symbols (${indexed.ms}ms)`);
    }
    console.log("/help for commands, /exit to quit\n");

    // `rl.question` in a loop drops buffered lines when stdin is a pipe, so a
    // scripted session ran only its first command. Consuming the line stream
    // works for both a terminal and a pipe.
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY === true,
    });
    let lastPrompt = "";

    const interactive = process.stdin.isTTY === true;
    if (interactive) process.stdout.write("› ");

    for await (const raw of rl) {
      const line = raw.trim();
      if (line === "") {
        if (interactive) process.stdout.write("› ");
        continue;
      }

      if (isCommand(line)) {
        const result = await runCommand(line, {
          session,
          telemetryPath,
          lastPrompt,
        });
        if (result.output !== "") console.log(`${result.output}\n`);
        if (result.exit) break;
        continue;
      }

      lastPrompt = line;
      try {
        const result = await session.prompt(line);
        console.log(`\n${result.text}\n`);
        // A per-turn cost line is the whole product thesis made visible.
        console.log(
          `  [${result.layer}] ${result.tokens.input + result.tokens.cached + result.tokens.output} tokens · ${usd(result.costUsd)}\n`,
        );
      } catch (error) {
        console.error(`error: ${(error as Error).message}\n`);
      }
    }

    rl.close();
    return 0;
  } finally {
    session.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
