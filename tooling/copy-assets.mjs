import { copyFileSync } from "node:fs";

copyFileSync("fixtures/community/compose.yml", "packages/testkit/dist/compose.yml");
