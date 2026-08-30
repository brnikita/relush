import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * `pnpm bench:smoke` — the 5-task smoke suite (SPEC §4.9).
 *
 * Delegates to the Python eval harness rather than reimplementing it, so the
 * smoke run and a full eval measure the same way.
 *
 * This needs a live provider, so unlike the rest of the checks it cannot run in
 * CI (see docs/testing.md). Without a key it skips rather than fails: a missing
 * credential is not a broken build, and failing here would push people toward
 * disabling the check.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function main(): number {
  if (!process.env["OPENROUTER_API_KEY"]) {
    console.log("bench:smoke — SPEC §4.9");
    console.log("  SKIPPED: OPENROUTER_API_KEY not set (live provider required)");
    return 0;
  }

  if (!existsSync(`${repoRoot}packages/cli/dist/bin/run-task.js`)) {
    console.error("bench:smoke: agent not built. Run `pnpm build` first.");
    return 1;
  }

  const result = spawnSync(
    "uv",
    ["run", "--project", "eval", "nodrel-eval", "run", "--suite", "smoke", "--seeds", "1"],
    { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" },
  );

  if (result.error) {
    console.error(`bench:smoke: could not run eval harness: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

process.exit(main());
