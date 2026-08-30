import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countTextTokens } from "@nodrel/ai";
import { graphQuery } from "@nodrel/context";
import { indexFiles, resolveCrossFileCalls, SqliteGraphStore } from "@nodrel/graph";

/**
 * `pnpm bench:graph` — the §4.2 performance gates.
 *
 *   full index of 1M LOC   ≤ 60 s
 *   incremental reindex    ≤  5 s
 *   query p95              ≤ 100 ms
 *
 * The spec pins three OSS repos by commit hash for this. Those are not vendored
 * yet, so the corpus is **synthesized** to the same scale and the report says
 * so. A synthetic corpus measures the store and the parser honestly; what it
 * cannot measure is real-world naming and call density, which is why the gate
 * is not claimed as met until the pinned corpus lands.
 */

/** Generates a source file of roughly `lines` lines with realistic structure. */
function syntheticModule(index: number, lines: number): string {
  const parts: string[] = [`// module ${index}`];
  const perSymbol = 12;
  const symbols = Math.max(1, Math.floor(lines / perSymbol));

  for (let s = 0; s < symbols; s++) {
    parts.push(
      `/** Does work ${s} in module ${index}. */`,
      `export function fn_${index}_${s}(a: string, b: number): boolean {`,
      `  const local = a.length + b;`,
      `  if (local > 0) {`,
      `    return helper_${index}_${(s + 1) % symbols}(local);`,
      `  }`,
      `  return false;`,
      `}`,
      `function helper_${index}_${s}(v: number): boolean {`,
      `  return v % 2 === 0;`,
      `}`,
      ``,
    );
  }
  return parts.join("\n");
}

function buildCorpus(targetLines: number): { dir: string; files: string[]; lines: number } {
  const dir = mkdtempSync(join(tmpdir(), "nodrel-bench-"));
  const files: string[] = [];
  const linesPerFile = 400;
  const fileCount = Math.ceil(targetLines / linesPerFile);

  let total = 0;
  for (let i = 0; i < fileCount; i++) {
    const source = syntheticModule(i, linesPerFile);
    const path = join(dir, `mod_${String(i).padStart(5, "0")}.ts`);
    writeFileSync(path, source, "utf8");
    files.push(path);
    total += source.split("\n").length;
  }
  return { dir, files, lines: total };
}

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? 0;
};

interface GateResult {
  readonly label: string;
  readonly measured: string;
  readonly budget: string;
  readonly pass: boolean;
}

async function main(): Promise<number> {
  const targetLines = Number(process.env["BENCH_LINES"] ?? 1_000_000);
  console.log("bench:graph — SPEC §4.2\n");
  console.log(`  corpus: SYNTHETIC (pinned OSS corpus not yet vendored)`);

  process.stdout.write("  generating… ");
  const corpus = buildCorpus(targetLines);
  console.log(`${corpus.files.length} files, ${corpus.lines.toLocaleString("en-US")} lines`);

  const store = new SqliteGraphStore({ path: join(corpus.dir, "graph.db") });
  store.init();

  process.stdout.write("  full index… ");
  const full = await indexFiles(store, corpus.dir, corpus.files);
  resolveCrossFileCalls(store);
  console.log(`${(full.durationMs / 1000).toFixed(1)}s`);

  process.stdout.write("  incremental… ");
  const incremental = await indexFiles(store, corpus.dir, corpus.files);
  console.log(`${(incremental.durationMs / 1000).toFixed(2)}s`);

  // Query latency across the operation mix, on symbols that exist.
  const sample = store.findNodes({ limit: 200 }).filter((node) => node.kind !== "file");
  const latencies: number[] = [];
  const operations = ["symbol", "references", "dependencies", "impact", "overview"] as const;

  process.stdout.write("  queries… ");
  for (const node of sample) {
    for (const op of operations) {
      const arg = op === "overview" ? node.path : node.name;
      const started = performance.now();
      graphQuery({ op, arg }, { store, countTokens: countTextTokens });
      latencies.push(performance.now() - started);
    }
  }
  console.log(`${latencies.length} queries`);

  const stats = store.stats();
  console.log(
    `\n  indexed: ${stats.nodes.toLocaleString("en-US")} nodes, ` +
      `${stats.edges.toLocaleString("en-US")} edges, ${stats.files.toLocaleString("en-US")} files`,
  );

  const speedup = full.durationMs / Math.max(1, incremental.durationMs);
  const p95 = percentile(latencies, 95);

  const gates: GateResult[] = [
    {
      label: "full index",
      measured: `${(full.durationMs / 1000).toFixed(1)}s`,
      budget: "60s",
      pass: full.durationMs <= 60_000,
    },
    {
      label: "incremental",
      measured: `${(incremental.durationMs / 1000).toFixed(2)}s`,
      budget: "5s",
      pass: incremental.durationMs <= 5_000,
    },
    {
      label: "incremental speedup",
      measured: `${speedup.toFixed(1)}x`,
      budget: "4x",
      pass: speedup >= 4,
    },
    {
      label: "query p95",
      measured: `${p95.toFixed(1)}ms`,
      budget: "100ms",
      pass: p95 <= 100,
    },
  ];

  console.log("");
  for (const gate of gates) {
    console.log(
      `  ${gate.pass ? "PASS" : "FAIL"}  ${gate.label.padEnd(22)} ` +
        `${gate.measured.padStart(8)}  (budget ${gate.budget})`,
    );
  }

  store.close();

  const failed = gates.filter((g) => !g.pass);
  if (failed.length > 0) {
    console.error(
      `\n  ${failed.length} gate(s) missed. SPEC §9: open a DEVIATION with the data.\n` +
        "  Do not lower the budget.",
    );
    return 1;
  }

  console.log("\n  All §4.2 gates met on the synthetic corpus.");
  console.log("  NOT claimable until eval/corpus.lock pins the real repos.");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
