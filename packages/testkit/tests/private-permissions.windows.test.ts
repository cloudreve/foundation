import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { windowsPrivacy } from "../src/private-permissions.js";

it.runIf(process.platform === "win32")(
  "protects custom fixture directories and rejects broad file ACLs",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "testkit-acl-"));
    const path = join(root, "凭据's.json");

    try {
      await windowsPrivacy(root, true, true);
      await writeFile(path, "{}");
      await windowsPrivacy(path);

      const script = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$path = [Console]::In.ReadToEnd() | ConvertFrom-Json
$acl = Get-Acl -LiteralPath $path
$identity = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'Read', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $path -AclObject $acl
`;

      await new Promise<void>((resolve, reject) => {
        const child = execFile(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", script],
          (error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          },
        );

        child.stdin!.end(JSON.stringify(path));
      });

      await expect(windowsPrivacy(path)).rejects.toThrow("restricted to its owner");
      await windowsPrivacy(path, true);
      await windowsPrivacy(path);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
