import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packagesDir = fileURLToPath(new URL("./packages", import.meta.url));

/**
 * Resolve `@nodrel/*` to source rather than `dist/`.
 *
 * Without this, a cross-package test silently runs against whatever was last
 * built — so a new export appears missing until someone remembers to rebuild,
 * and worse, a test can pass against stale output. Aliasing to source makes
 * `pnpm test` independent of build state.
 */
const workspaceAliases = Object.fromEntries(
  readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => [`@nodrel/${entry.name}`, `${packagesDir}/${entry.name}/src/index.ts`]),
);

export default defineConfig({
  resolve: { alias: workspaceAliases },
  test: {
    include: ["packages/*/src/**/*.test.ts", "scripts/**/*.test.ts"],
    environment: "node",
    // Live-model tests are opt-in: they cost requests and depend on a shared
    // free-tier pool that returns 429 unpredictably. See docs/testing.md.
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.live.test.ts"],
    coverage: { provider: "v8", reporter: ["text", "json"] },
  },
});
