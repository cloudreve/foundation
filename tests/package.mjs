import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { digest, verifyInstalledPackage } from "@cloudreve/quality/artifacts";

const root = process.cwd();
const directory = await mkdtemp(join(tmpdir(), "cloudreve-packages-"));
const destination = join(root, ".artifacts/packages");
const records = [];

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });

try {
  for (const name of ["quality", "testkit"]) {
    const metadata = JSON.parse(
      await readFile(join(root, "packages", name, "package.json"), "utf8"),
    );

    assert.equal(metadata.private, undefined);
    assert.equal(metadata.license, "MIT");
    assert.equal(metadata.publishConfig.access, "public");

    execFileSync("bun", ["pm", "pack", "--destination", destination], {
      cwd: join(root, "packages", name),
      stdio: "pipe",
    });

    const packed = join(destination, `cloudreve-${name}-${metadata.version}.tgz`);
    const sha256 = await digest(packed);
    const filename = `cloudreve-${name}-${metadata.version}.tgz`;
    const archive = packed;

    await writeFile(archive + ".sha256", `${sha256}  ${filename}\n`);

    const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");

    assert(
      entries.every((entry) =>
        /^package\/(?:dist\/|package\.json$|README\.md$|LICENSE$)/.test(entry),
      ),
    );

    assert(entries.includes("package/LICENSE"));

    const consumer = join(directory, name);

    await mkdir(consumer);

    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );

    execFileSync("bun", ["add", "--ignore-scripts", "--linker", "hoisted", archive], {
      cwd: consumer,
      stdio: "pipe",
    });

    await verifyInstalledPackage(archive, join(consumer, "node_modules/@cloudreve", name));

    const specifiers = Object.keys(metadata.exports).map((key) => metadata.name + key.slice(1));

    const proof = `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
for (const name of ${JSON.stringify(specifiers)}) await import(name);
const require = createRequire(import.meta.url);
for (const name of ${JSON.stringify(name === "quality" ? ["testcontainers", "@cloudreve/testkit", "@cloudreve/sdk"] : ["@cloudreve/quality", "@cloudreve/sdk"])}) {
  assert.throws(() => require.resolve(name), {code:'MODULE_NOT_FOUND'});
}
`;

    await writeFile(join(consumer, "consumer.mjs"), proof);
    execFileSync(process.execPath, ["consumer.mjs"], { cwd: consumer, stdio: "pipe" });

    await writeFile(
      join(consumer, "types.mts"),
      specifiers
        .map(
          (specifier, index) =>
            `import * as module${index} from ${JSON.stringify(specifier)}; export { module${index} };`,
        )
        .join("\n"),
    );

    execFileSync(
      process.execPath,
      [
        resolve("node_modules/typescript/bin/tsc"),
        "--ignoreConfig",
        "--noEmit",
        "--module",
        "nodenext",
        "--target",
        "es2023",
        "--skipLibCheck",
        "types.mts",
      ],
      { cwd: consumer, stdio: "pipe" },
    );

    records.push({ name: metadata.name, version: metadata.version, file: filename, sha256 });

    console.log(
      `${metadata.name}: installed bytes, exports, declarations and dependency isolation passed`,
    );
  }

  await writeFile(join(destination, "manifest.json"), JSON.stringify(records, null, 2) + "\n");
} finally {
  await rm(directory, { recursive: true, force: true });
}
