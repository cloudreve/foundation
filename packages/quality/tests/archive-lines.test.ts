import { expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mock = vi.hoisted(() => ({ embeddedControl: false }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const execFile = vi.fn();

  Object.defineProperty(execFile, promisify.custom, {
    value: async (executable: string, args: string[], options: object) => {
      const result = await promisify(actual.execFile)(executable, args, {
        ...options,
        encoding: "buffer",
      });

      if (args[0] === "-tzf") {
        let listing = result.stdout.toString().replace(/\r?\n/g, "\r\n");

        if (mock.embeddedControl) {
          listing = listing.replace("package.json", "package\r.json");
        }

        result.stdout = Buffer.from(listing);
      }

      return result;
    },
  });

  return { ...actual, execFile };
});

import { verifyInstalledPackage } from "../src/artifacts.js";

it("accepts CRLF archive listing records while rejecting embedded controls", async () => {
  const root = await mkdtemp(join(tmpdir(), "archive-lines-"));
  const pkg = join(root, "package");
  const archive = join(root, "package.tgz");

  const tar =
    process.platform === "win32"
      ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
      : "tar";

  try {
    await mkdir(pkg);
    await writeFile(join(pkg, "package.json"), "{}");
    await writeFile(join(pkg, "index.js"), "export const answer = 42;");
    execFileSync(tar, ["-czf", archive, "-C", root, "package"]);
    await verifyInstalledPackage(archive, pkg);
    mock.embeddedControl = true;

    await expect(verifyInstalledPackage(archive, pkg)).rejects.toThrow(
      "Unsafe package archive member",
    );
  } finally {
    mock.embeddedControl = false;
    await rm(root, { recursive: true, force: true });
  }
});
