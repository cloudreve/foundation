import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest, verifyArtifact, verifyInstalledPackage } from "../src/artifacts.js";

it("distinguishes installed dependencies from owned package files", async () => {
  const root = await mkdtemp(join(tmpdir(), "quality-package-"));
  const pkg = join(root, "package");
  const archive = join(root, "sdk.tgz");

  try {
    await mkdir(pkg);

    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({ name: "sdk", dependencies: { valibot: "1.5.0" } }),
    );

    await writeFile(join(pkg, "index.js"), "export const sdk=true;");
    execFileSync("tar", ["-czf", archive, "-C", root, "package"]);
    await mkdir(join(pkg, "node_modules/valibot"), { recursive: true });
    await writeFile(join(pkg, "node_modules/valibot/index.js"), "managed dependency");
    await verifyInstalledPackage(archive, pkg);
    await mkdir(join(pkg, "node_modules/extra"));
    await writeFile(join(pkg, "node_modules/extra/index.js"), "unexpected");
    await expect(verifyInstalledPackage(archive, pkg)).rejects.toThrow("unexpected");
    await rm(join(pkg, "node_modules/extra"), { recursive: true });
    await rm(join(pkg, "node_modules/valibot"), { recursive: true });
    await mkdir(join(root, "installed"));
    await writeFile(join(root, "installed/index.js"), "dependency cache");
    await symlink(join(root, "installed"), join(pkg, "node_modules/valibot"), "junction");
    await verifyInstalledPackage(archive, pkg);
    await rm(join(pkg, "node_modules/valibot"));
    await writeFile(join(pkg, "node_modules/valibot"), "not a package directory");
    await expect(verifyInstalledPackage(archive, pkg)).rejects.toThrow("directory");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("accepts only installer binary links backed by a declared dependency executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "quality-binaries-"));

  const pkg = join(root, "package");
  const archive = join(root, "sdk.tgz");

  const dependency = join(pkg, "node_modules/semver");
  const shim = join(pkg, "node_modules/.bin/semver");

  try {
    await mkdir(pkg);

    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({ name: "sdk", dependencies: { semver: "7.7.4" } }),
    );

    await writeFile(join(pkg, "index.js"), "owned package bytes");
    execFileSync("tar", ["-czf", archive, "-C", root, "package"]);
    await mkdir(join(dependency, "bin"), { recursive: true });
    await mkdir(join(pkg, "node_modules/.bin"));

    const metadata = (bin: unknown) =>
      writeFile(join(dependency, "package.json"), JSON.stringify({ name: "semver", bin }));

    await metadata({ semver: "bin/semver.js" });
    await writeFile(join(dependency, "bin/semver.js"), "dependency executable");
    await symlink("../semver/bin/semver.js", shim);
    await verifyInstalledPackage(archive, pkg);
    await metadata("bin/semver.js");
    await verifyInstalledPackage(archive, pkg);

    for (const bin of [
      undefined,
      { wrong: "bin/semver.js" },
      { semver: "bin/other.js" },
      { semver: 1 },
    ]) {
      await metadata(bin);
      await expect(verifyInstalledPackage(archive, pkg)).rejects.toThrow("symbolic link");
    }

    await metadata({ semver: "bin/semver.js" });
    await rm(shim);
    await symlink("../../index.js", shim);
    await expect(verifyInstalledPackage(archive, pkg)).rejects.toThrow("symbolic link");
    await rm(shim);
    await symlink("../semver/bin/semver.js", shim);
    await rm(join(dependency, "bin/semver.js"));
    await symlink(join(pkg, "index.js"), join(dependency, "bin/semver.js"));
    await expect(verifyInstalledPackage(archive, pkg)).rejects.toThrow("symbolic link");
    await rm(join(dependency, "bin/semver.js"));
    await mkdir(join(dependency, "bin/semver.js"));
    await expect(verifyInstalledPackage(archive, pkg)).rejects.toThrow("symbolic link");
    await rm(join(dependency, "bin/semver.js"), { recursive: true });
    await writeFile(join(dependency, "bin/semver.js"), "dependency executable");
    await writeFile(join(pkg, "node_modules/.bin/unrecognized"), "unexpected own file");
    await expect(verifyInstalledPackage(archive, pkg)).rejects.toThrow("unexpected files");
    await rm(join(pkg, "node_modules/.bin/unrecognized"));
    await writeFile(join(pkg, "index.js"), "modified own file");
    await expect(verifyInstalledPackage(archive, pkg)).rejects.toThrow("differs");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects mismatched package identities even when archive bytes match", async () => {
  const root = await mkdtemp(join(tmpdir(), "quality-identity-"));
  const archive = join(root, "cloudreve-sdk-0.1.0.tgz");

  try {
    await mkdir(join(root, "package"));

    await writeFile(
      join(root, "package/package.json"),
      JSON.stringify({ name: "@cloudreve/sdk", version: "0.1.0" }),
    );

    execFileSync("tar", ["-czf", archive, "-C", root, "package"]);

    const record = {
      schemaVersion: 1 as const,
      file: "cloudreve-sdk-0.1.0.tgz",
      sha256: await digest(archive),
      packageName: "@cloudreve/sdk",
      version: "0.1.0",
    };

    for (const patch of [{ packageName: "@cloudreve/other" }, { version: "0.2.0" }]) {
      await expect(verifyArtifact(archive, { ...record, ...patch })).rejects.toThrow(
        "identity mismatch",
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("verifies bundled dependencies and rejects unsafe dependency names", async () => {
  const root = await mkdtemp(join(tmpdir(), "quality-bundled-"));
  const pkg = join(root, "package");
  const archive = join(root, "sdk.tgz");

  try {
    await mkdir(join(pkg, "node_modules/bundled"), { recursive: true });
    await writeFile(join(pkg, "node_modules/bundled/index.js"), "bundled bytes");

    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({ dependencies: { bundled: "1.0.0" } }),
    );

    execFileSync("tar", ["-czf", archive, "-C", root, "package"]);
    await verifyInstalledPackage(archive, pkg);
    await writeFile(join(pkg, "node_modules/bundled/index.js"), "changed bytes");
    await expect(verifyInstalledPackage(archive, pkg)).rejects.toThrow("differs");

    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({ dependencies: { "../escape": "1.0.0" } }),
    );

    execFileSync("tar", ["-czf", archive, "-C", root, "package"]);

    await expect(verifyInstalledPackage(archive, pkg)).rejects.toThrow(
      "Invalid declared dependency",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
