import { afterEach, beforeEach, expect, it } from "vitest";
import { realpath, mkdtemp, readFile, rm, symlink, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  artifactRecord,
  digest,
  ownedProject,
  vendorArtifact,
  verifyArtifact,
} from "../packages/quality/src/artifacts.js";

const tarExecutable =
  process.platform === "win32"
    ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";

async function archive(path: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");

  await mkdir(join(dir, "package"), { recursive: true });

  await writeFile(
    join(dir, "package/package.json"),
    JSON.stringify({ name: "@cloudreve/sdk", version: "0.1.0" }),
  );

  await promisify(execFile)(tarExecutable, ["-czf", path, "-C", dir, "package"]);
}

let dir: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "artifact-test-")));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it("pins actual bytes and vendors the artifact with checksum", async () => {
  const source = join(dir, "cloudreve-sdk-0.1.0.tgz");

  await archive(source);

  const record = artifactRecord({
    schemaVersion: 1,
    file: "cloudreve-sdk-0.1.0.tgz",
    sha256: await digest(source),
    packageName: "@cloudreve/sdk",
    version: "0.1.0",
  });

  const consumer = join(dir, "consumer");

  await mkdir(consumer);

  const target = await vendorArtifact(source, consumer, record);

  expect(await readFile(target)).toEqual(await readFile(source));
  expect(await readFile(target + ".sha256", "utf8")).toContain(record.sha256);
  await writeFile(source, "changed");
  await expect(verifyArtifact(source, record)).rejects.toThrow("mismatch");
});

it.each([null, 1, {}, { schemaVersion: 1, file: "../x" }])("rejects invalid metadata %j", (value) =>
  expect(() => artifactRecord(value)).toThrow(),
);

it("rejects redirected vendor directories and wrong filename", async () => {
  const source = join(dir, "cloudreve-sdk-0.1.0.tgz");

  await archive(source);

  const record = {
    schemaVersion: 1 as const,
    file: "cloudreve-sdk-0.1.0.tgz",
    sha256: await digest(source),
    packageName: "@cloudreve/sdk",
    version: "0.1.0",
  };

  await mkdir(join(dir, "real"));
  await symlink(join(dir, "real"), join(dir, "vendor"), "junction");

  await expect(vendorArtifact(source, dir, record)).rejects.toThrow("redirected");

  await expect(verifyArtifact(join(dir, "other.tgz"), record)).rejects.toThrow("mismatch");
});

it("rejects every malformed identity field", () => {
  const valid = {
    schemaVersion: 1,
    file: "cloudreve-sdk-0.1.0.tgz",
    sha256: "a".repeat(64),
    packageName: "@cloudreve/sdk",
    version: "0.1.0",
  };

  for (const patch of [
    { schemaVersion: 2 },
    { file: "../escape" },
    { sha256: "bad" },
    { packageName: "foreign" },
    { version: "latest" },
  ]) {
    expect(() => artifactRecord({ ...valid, ...patch })).toThrow();
  }
});

it("requires a proper child for integration checkout paths", () => {
  expect(ownedProject("/tmp/run", "sdk")).toBe(resolve("/tmp/run/sdk"));

  for (const path of ["..", ".", "/other"]) {
    expect(() => ownedProject("/tmp/run", path)).toThrow();
  }
});

it("detects stale installed package bytes, extra files and symlinks", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");

  const exec = promisify(execFile);

  const { verifyInstalledPackage } = await import("../packages/quality/src/artifacts.js");

  const pack = join(dir, "package");

  await mkdir(join(pack, "dist"), { recursive: true });
  await writeFile(join(pack, "package.json"), "{}");
  await writeFile(join(pack, "dist/index.js"), "export const answer=42;");

  const archive = join(dir, "package.tgz");

  await exec(tarExecutable, ["-czf", archive, "-C", dir, "package"]);
  await verifyInstalledPackage(archive, pack);
  await writeFile(join(pack, "dist/index.js"), "old cached bytes");

  await expect(verifyInstalledPackage(archive, pack)).rejects.toThrow("differs");

  await writeFile(join(pack, "dist/index.js"), "export const answer=42;");
  await writeFile(join(pack, "extra"), "unexpected");

  await expect(verifyInstalledPackage(archive, pack)).rejects.toThrow("unexpected");

  await rm(join(pack, "extra"));
  await symlink(join(pack, "package.json"), join(pack, "extra"));

  await expect(verifyInstalledPackage(archive, pack)).rejects.toThrow("symbolic");

  await rm(join(pack, "extra"));
  await rm(join(pack, "dist/index.js"));
  await symlink(join(pack, "package.json"), join(pack, "dist/index.js"));

  await expect(verifyInstalledPackage(archive, pack)).rejects.toThrow("redirected");
});

it("rejects archives outside the npm package root", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");

  const { verifyInstalledPackage } = await import("../packages/quality/src/artifacts.js");

  await writeFile(join(dir, "foreign"), "x");

  const archive = join(dir, "foreign.tgz");

  await promisify(execFile)(tarExecutable, ["-czf", archive, "-C", dir, "foreign"]);
  await expect(verifyInstalledPackage(archive, dir)).rejects.toThrow("Unsafe");
});
