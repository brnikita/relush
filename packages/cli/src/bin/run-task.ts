#!/usr/bin/env node
import { runTask } from "../run-task.ts";

/**
 * `nodrel-run-task` — executes one eval task and prints its result as JSON.
 *
 * The Python eval harness (SPEC §4.9) invokes this once per task. Only JSON
 * goes to stdout; anything diagnostic goes to stderr, so the harness can parse
 * stdout without a protocol.
 */

interface Args {
  prompt: string;
  cwd: string;
  model: string;
  timeoutMs: number;
  history: boolean;
  graph: boolean;
  maxTokens: number | undefined;
  fallbackModels: string[];
}

function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };

  const prompt = get("--prompt");
  const cwd = get("--cwd");
  if (prompt === undefined || cwd === undefined) {
    throw new Error(
      "usage: nodrel-run-task --prompt <text> --cwd <dir> [--model <id>] [--timeout-ms <n>] [--history] [--graph] [--fallback <id,id>]",
    );
  }

  return {
    prompt,
    cwd,
    model: get("--model") ?? "z-ai/glm-5.3-flash",
    timeoutMs: Number(get("--timeout-ms") ?? 600_000),
    history: argv.includes("--history"),
    graph: argv.includes("--graph"),
    maxTokens: get("--max-tokens") === undefined ? undefined : Number(get("--max-tokens")),
    fallbackModels: (get("--fallback") ?? "").split(",").filter(Boolean),
  };
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }

  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) {
    console.error("OPENROUTER_API_KEY is not set");
    return 2;
  }

  const result = await runTask({
    prompt: args.prompt,
    cwd: args.cwd,
    modelId: args.model,
    apiKey,
    timeoutMs: args.timeoutMs,
    history: args.history,
    graph: args.graph,
    ...(args.maxTokens === undefined ? {} : { maxTokens: args.maxTokens }),
    fallbackModels: args.fallbackModels,
  });

  process.stdout.write(`${JSON.stringify(result)}\n`);
  // A task that errored still produced a usable data point, so this exits 0.
  // The harness decides pass/fail from its own verification command.
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
