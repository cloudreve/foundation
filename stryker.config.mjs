import { readFileSync } from "node:fs";

const lines = readFileSync("packages/testkit/src/driver.ts", "utf8").split("\n");

const guard = lines.findIndex((line) => line.includes('labels["dev.cloudreve.worktree"]')) + 1;

if (!guard) {
  throw Error("Fixture ownership guard moved; review mutation target");
}

export default {
  mutate: [`packages/testkit/src/driver.ts:${guard}:0-${guard + 2}:100`],
  plugins: ["@stryker-mutator/vitest-runner"],
  testRunner: "vitest",
  vitest: { configFile: "vitest.config.ts" },
  coverageAnalysis: "perTest",
  concurrency: 2,
  reporters: ["clear-text", "json"],
  jsonReporter: { fileName: ".artifacts/mutation.json" },
  thresholds: { high: 100, low: 100, break: 100 },
  tempDirName: ".artifacts/stryker",
};
