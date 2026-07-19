import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // Resolve workspace packages to their TS source so unit tests run without a
  // prior build; the published `exports` point at dist for the compiled apps.
  resolve: {
    alias: {
      "@empire/db": r("./packages/db/src/index.ts"),
      "@empire/core": r("./packages/core/src/index.ts"),
      "@empire/content-schemas": r("./packages/content-schemas/src/index.ts"),
    },
  },
  test: {
    globals: false,
    environment: "node",
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    // Integration suites share one Postgres and TRUNCATE between cases; files
    // must not interleave or they wipe each other's seeds mid-test.
    fileParallelism: false,
    // The single integration suite (ledger atomic trade against real Postgres)
    // is opt-in: it requires DATABASE_URL and is run explicitly / in CI.
    testTimeout: 20_000,
  },
});
