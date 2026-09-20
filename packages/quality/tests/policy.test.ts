import { expect, it } from "vitest";
import { ESLint } from "eslint";
import {
  sdkConfig,
  nodeConfig,
  structuralSpacing,
  modernJavaScript,
  createTypedConfig,
} from "../src/eslint.js";
import { moduleRules, sdkRules } from "../src/dependencies.js";
import prettier from "../src/prettier.js";

it("uses portable shared formatting defaults", () => {
  expect(prettier).toMatchObject({ printWidth: 100, endOfLine: "lf", semi: true });
});

it("rejects every platform-global escape through maintained scope-aware lint rules", async () => {
  const lint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: sdkConfig,
  });

  for (const code of [
    'window.fetch("/")',
    'globalThis["fetch"]("/")',
    "const f=fetch;",
    "declare const document:any; document.title",
    'declare function fetch(url:string):any; fetch("/")',
    "const x={document};",
    'import fs from "node:fs"; fs.statSync("x")',
  ]) {
    const [result] = await lint.lintText(code, { filePath: "src/input.ts" });

    expect(
      result!.messages.some((m) => m.ruleId?.startsWith("no-restricted")),
      code,
    ).toBe(true);
  }

  for (const code of [
    "export function save(document:unknown){return document;}",
    'export const fetch=(value:string)=>value;fetch("x");',
    "export const x={document:1,fetch(){return 1}}; export const value=x.document;",
  ]) {
    const [result] = await lint.lintText(code, { filePath: "src/input.ts" });

    expect(result!.messages, code).toEqual([]);
  }

  const [broken] = await lint.lintText("const =", { filePath: "src/input.ts" });

  expect(broken!.fatalErrorCount).toBe(1);
});

it("validates dependency maps and explicitly names allowed SDK runtime packages", () => {
  expect(moduleRules({ protocol: [], session: ["protocol"] })).toHaveLength(4);
  expect(moduleRules({ "resources/files": [] })).toHaveLength(3);
  expect(sdkRules({ files: [] }, ["valibot"]).at(-1)?.to.pathNot).toContain("valibot");
  expect(sdkRules({ files: [] }).at(-1)?.to.pathNot).toBe("^src/");

  for (const map of [{}, { "bad.name": [] }, { a: ["a"] }, { a: ["unknown"] }]) {
    expect(() => moduleRules(map)).toThrow();
  }

  expect(() => moduleRules({ a: [] }, "../src")).toThrow();
  expect(() => sdkRules({ a: [] }, ["../escape"])).toThrow();
});

it("fixes structural spacing and declaration rules without changing behavior", async () => {
  const options = {
    overrideConfigFile: true as const,
    overrideConfig: [...nodeConfig, modernJavaScript, structuralSpacing],
  };

  const code =
    "export function double(value: number) { const result = value * 2; if (value) return result; return 0; }";

  const [before] = await new ESLint(options).lintText(code, { filePath: "src/input.ts" });

  expect(before!.messages.map((message) => message.ruleId)).toContain("curly");

  expect(before!.messages.map((message) => message.ruleId)).toContain(
    "@stylistic/padding-line-between-statements",
  );

  const [fixed] = await new ESLint({ ...options, fix: true }).lintText(code, {
    filePath: "src/input.ts",
  });

  expect(fixed!.messages).toEqual([]);
  expect(fixed!.output).toContain("\n\n");

  const [again] = await new ESLint(options).lintText(fixed!.output!, { filePath: "src/input.ts" });

  expect(again!.messages).toEqual([]);
});

it("enables type-aware promise checks using the consumer project", async () => {
  const lint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [...nodeConfig, createTypedConfig(process.cwd())],
  });

  const filePath = "packages/quality/src/prettier.ts";
  const [invalid] = await lint.lintText("Promise.resolve(1);", { filePath });

  expect(invalid!.messages.map((message) => message.ruleId)).toContain(
    "@typescript-eslint/no-floating-promises",
  );

  const [valid] = await lint.lintText("void Promise.resolve(1);", { filePath });

  expect(valid!.messages).toEqual([]);
});
