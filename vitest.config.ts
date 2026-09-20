import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@cloudreve/testkit/community": fileURLToPath(
        new URL("./packages/testkit/src/community.ts", import.meta.url),
      ),
      "@cloudreve/quality/artifacts": fileURLToPath(
        new URL("./packages/quality/src/artifacts.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["tests/**/*.test.ts", "packages/*/tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts", "tooling/release-version.mjs"],
      reporter: ["text", "json-summary", "html"],
      thresholds: { statements: 95, branches: 95, functions: 95, lines: 95 },
    },
  },
});
