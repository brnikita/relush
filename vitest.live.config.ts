import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packagesDir = fileURLToPath(new URL("./packages", import.meta.url));

/** Same source aliasing as the default config; see vitest.config.ts. */
const workspaceAliases = Object.fromEntries(
  readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => [`@nodrel/${entry.name}`, `${packagesDir}/${entry.name}/src/index.ts`]),
);

/**
 * Live-model tests. Separate from the default config because these make real,
 * billed provider calls and depend on upstream availability — neither belongs
 * in `pnpm test` or CI. See docs/testing.md.
 */
export default defineConfig({
  resolve: { alias: workspaceAliases },
  test: {
    include: ["packages/*/src/**/*.live.test.ts"],
    environment: "node",
    // Real network calls; the default 5s is not enough.
    testTimeout: 60_000,
    // Free-tier pools rate-limit under concurrency.
    fileParallelism: false,
    retry: 1,
  },
});
