import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import writeFileAtomic from "write-file-atomic";
import lockfile from "proper-lockfile";
import { validateCredentialPaths, validateFixture, type Fixture } from "./manifest.js";

export async function directory(path: string): Promise<string> {
  const target = resolve(path);

  await mkdir(target, { recursive: true, mode: 0o700 });

  if ((await realpath(target)) !== target) {
    throw new Error("Redirected fixture directory");
  }

  return target;
}

export async function readPrivate(path: string): Promise<unknown> {
  const info = await lstat(path);

  // Windows file permissions use inherited ACLs rather than POSIX mode bits.
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (process.platform !== "win32" && (info.mode & 0o077) !== 0)
  ) {
    throw new Error("Expected a regular private fixture file");
  }

  return JSON.parse(await readFile(path, "utf8"));
}

export async function writePrivate(path: string, value: unknown): Promise<void> {
  await directory(dirname(path));

  try {
    const info = await lstat(path);

    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("Refusing redirected fixture file");
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw e;
    }
  }

  await writeFileAtomic(path, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    fsync: true,
  });
}

export async function readManifest(path: string, owner: string): Promise<Fixture> {
  const fixture = validateFixture(await readPrivate(path), owner);

  validateCredentialPaths(fixture, path);

  return fixture;
}

export async function readFixture(path: string, owner: string): Promise<Fixture> {
  const fixture = await readManifest(path, owner);

  if (fixture.status !== "ready") {
    throw new Error("Fixture is not ready");
  }

  return fixture;
}

export async function acquire(path: string): Promise<() => Promise<void>> {
  const root = await directory(path);

  return lockfile.lock(root, {
    realpath: true,
    stale: 30_000,
    update: 5_000,
    retries: 0,
  });
}

export async function exclusive<T>(path: string, work: () => Promise<T>): Promise<T> {
  const release = await acquire(path);

  try {
    return await work();
  } finally {
    await release();
  }
}
