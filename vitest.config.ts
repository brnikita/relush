import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "scripts/**/*.test.ts"],
    environment: "node",
    // Live-model tests are opt-in: they cost requests and depend on a shared
    // free-tier pool that returns 429 unpredictably. See docs/testing.md.
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.live.test.ts"],
    coverage: { provider: "v8", reporter: ["text", "json"] },
  },
});
