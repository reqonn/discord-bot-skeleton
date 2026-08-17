import { config as loadDotenv } from "dotenv";
import { defineConfig } from "vitest/config";

// Integration tests need DATABASE_URL / REDIS_URL. Node's --env-file covers
// `pnpm dev` and `pnpm start`; the test runner loads the same file here so
// there is exactly one place developers put local credentials.
loadDotenv({ path: ".env", quiet: true });

export default defineConfig({
  // Resolves the "#platform/*" subpath imports to ./src rather than ./dist.
  // Mirrors `customConditions` in tsconfig.json and `--conditions=development`
  // in the dev script — all three must agree.
  resolve: { conditions: ["development"] },
  ssr: { resolve: { conditions: ["development"] } },
  test: {
    // Every test lives in tests/, mirroring src/. src/ holds only shipped
    // code — an architecture test enforces both halves of that.
    include: ["tests/**/*.test.ts"],
    environment: "node",
    clearMocks: true,
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: [
        // Wiring, not logic: covered by the container smoke test, and a
        // coverage number here would measure nothing worth measuring.
        "src/main.ts",
        "src/app/**",
        "src/**/feature.ts",
      ],
    },
  },
});
