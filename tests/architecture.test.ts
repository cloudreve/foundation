import { expect, it } from "vitest";
import { cruise } from "dependency-cruiser";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moduleRules, sdkRules } from "../packages/quality/src/dependencies.js";

it("rejects invalid module maps instead of silently weakening rules", () => {
  for (const [map, root] of [
    [{}, "src"],
    [{ "bad.name": [] }, "src"],
    [{ a: [] }, "../src"],
    [{ a: ["a"] }, "src"],
    [{ a: ["missing"] }, "src"],
  ] as const) {
    expect(() => moduleRules(map, root)).toThrow();
  }

  expect(moduleRules({ a: [] }, "packages/core")).toHaveLength(3);
});

it("real graph checker accepts public edges and rejects private/native/circular edges", async () => {
  const dir = await mkdtemp(join(tmpdir(), "architecture-test-"));
  const previous = process.cwd();

  try {
    await mkdir(join(dir, "src", "protocol"), { recursive: true });
    await mkdir(join(dir, "src", "session"), { recursive: true });
    await writeFile(join(dir, "src/protocol/index.js"), "export const x=1;");
    await writeFile(join(dir, "src/protocol/private.js"), "export const y=2;");
    process.chdir(dir);

    const check = async (source: string) => {
      await writeFile("src/session/index.js", source);

      const result = await cruise(["src"], {
        validate: true,
        ruleSet: {
          forbidden: sdkRules({ protocol: [], session: ["protocol"] }),
        } as never,
      });

      return (result.output as { summary: { error: number } }).summary.error;
    };

    expect(await check('import {x} from "../protocol/index.js"; export {x};')).toBe(0);

    expect(await check('export {y} from "../protocol/private.js";')).toBeGreaterThan(0);

    expect(await check('import fs from "node:fs"; export {fs};')).toBeGreaterThan(0);

    await writeFile("src/protocol/index.js", 'export {x} from "../session/index.js";');

    expect(await check('export {x} from "../protocol/index.js";')).toBeGreaterThan(0);
  } finally {
    process.chdir(previous);
    await rm(dir, { recursive: true, force: true });
  }
});

it("enforces independent quality and testkit packages in the real graph checker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "foundation-boundary-"));
  const previous = process.cwd();

  const { createRequire } = await import("node:module");
  const config = createRequire(import.meta.url)("../.dependency-cruiser.cjs");

  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "src/index.js"), "export const coordinator=1;");

  try {
    for (const name of ["quality", "testkit"]) {
      await mkdir(join(dir, "packages", name, "src"), { recursive: true });
    }

    await writeFile(join(dir, "packages/quality/src/index.js"), "export const policy=1;");

    await writeFile(join(dir, "packages/testkit/src/index.js"), "export const fixture=1;");

    process.chdir(dir);

    const check = async () => {
      const result = await cruise(["packages", "src"], {
        validate: true,
        ruleSet: { forbidden: config.forbidden },
      });

      return (result.output as { summary: { error: number } }).summary.error;
    };

    expect(await check()).toBe(0);

    await writeFile(
      "packages/quality/src/index.js",
      'export {fixture} from "../../testkit/src/index.js";',
    );

    expect(await check()).toBeGreaterThan(0);
    await writeFile("packages/quality/src/index.js", "export const policy=1;");

    await writeFile(
      "packages/testkit/src/index.js",
      'export {policy} from "../../quality/src/index.js";',
    );

    expect(await check()).toBeGreaterThan(0);
    await writeFile("packages/testkit/src/index.js", "export const fixture=1;");
    expect(await check()).toBe(0);

    await writeFile("src/index.js", 'export {policy} from "../packages/quality/src/index.js";');

    expect(await check()).toBeGreaterThan(0);
  } finally {
    process.chdir(previous);
    await rm(dir, { recursive: true, force: true });
  }
});
