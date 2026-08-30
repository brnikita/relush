import { defineConfig } from "vitest/config";

/**
 * Live-model tests. Separate from the default config because these make real,
 * billed provider calls and depend on upstream availability — neither belongs
 * in `pnpm test` or CI. See docs/testing.md.
 */
export default defineConfig({
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
