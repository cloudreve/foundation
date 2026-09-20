import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  readFile,
  readlink,
  readdir,
  stat,
  copyFile,
  mkdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, resolve, relative, isAbsolute, sep, posix, join } from "node:path";

const execute = promisify(execFile);

// Git Bash tar treats Windows drive letters as remote hosts; use the native archive tool.
const tarExecutable =
  process.platform === "win32"
    ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";

const tar = (args: string[]) =>
  execute(tarExecutable, args, {
    encoding: "buffer",
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });

async function dependencyBinary(
  root: string,
  name: string,
  dependencies: ReadonlySet<string>,
): Promise<boolean> {
  if (posix.dirname(name) !== "node_modules/.bin") {
    return false;
  }

  const target = resolve(dirname(resolve(root, name)), await readlink(resolve(root, name)));
  const dependency = [...dependencies].find((path) => target.startsWith(resolve(root, path) + sep));

  if (!dependency) {
    return false;
  }

  const directory = resolve(root, dependency);
  const metadata = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8"));

  const bins =
    typeof metadata.bin === "string" ? { [basename(metadata.name)]: metadata.bin } : metadata.bin;

  const declared = bins?.[basename(name)];

  if (typeof declared !== "string" || resolve(directory, declared) !== target) {
    return false;
  }

  // Dependency directories may be installer links, but their declared executable cannot redirect.
  return (
    (await realpath(target)) === resolve(await realpath(directory), relative(directory, target)) &&
    (await stat(target)).isFile()
  );
}

async function installedFiles(
  root: string,
  prefix = "",
  dependencies: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const entries = await readdir(resolve(root, prefix), { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (dependencies.has(name)) {
      if (!(await stat(resolve(root, name))).isDirectory()) {
        throw new Error("Installed dependency must be a directory");
      }

      continue;
    }

    if (entry.isSymbolicLink()) {
      if (await dependencyBinary(root, name, dependencies)) {
        continue;
      }

      throw new Error("Installed package contains a symbolic link");
    }

    if (entry.isDirectory()) {
      files.push(...(await installedFiles(root, name, dependencies)));
    } else {
      files.push(name);
    }
  }

  return files;
}

/** Content-addressed identity of a packed npm package. */
export interface Artifact {
  schemaVersion: 1;
  file: string;
  sha256: string;
  packageName: string;
  version: string;
}

/** Compute the SHA-256 checksum of a file. */
export async function digest(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

/** Validate an untrusted package identity record before using it. */
export function artifactRecord(value: unknown): Artifact {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid artifact record");
  }

  const v = value as Artifact;

  if (
    v.schemaVersion !== 1 ||
    !/^cloudreve-[a-z0-9.-]+\.tgz$/.test(v.file) ||
    !/^[a-f0-9]{64}$/.test(v.sha256) ||
    !/^@cloudreve\/[a-z-]+$/.test(v.packageName) ||
    !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(v.version)
  ) {
    throw new Error("Invalid artifact identity");
  }

  return v;
}

/** Verify archive filename, checksum, package name and version. */
export async function verifyArtifact(path: string, record: Artifact): Promise<void> {
  artifactRecord(record);

  if (basename(path) !== record.file || (await digest(path)) !== record.sha256) {
    throw new Error("Artifact checksum or filename mismatch");
  }

  const packed = JSON.parse(
    (await tar(["-xOf", resolve(path), "package/package.json"])).stdout.toString("utf8"),
  );

  if (packed.name !== record.packageName || packed.version !== record.version) {
    throw new Error("Artifact package identity mismatch");
  }
}

/** Copy a verified package into a consumer’s vendor directory with its checksum. */
export async function vendorArtifact(
  source: string,
  consumer: string,
  record: Artifact,
): Promise<string> {
  await verifyArtifact(source, record);

  const root = await realpath(consumer);
  const filename = `${record.file.slice(0, -4)}-${record.sha256.slice(0, 12)}.tgz`;
  const target = resolve(root, "vendor", filename);

  await mkdir(dirname(target), { recursive: true });

  if ((await realpath(dirname(target))) !== dirname(target)) {
    throw new Error("Vendor directory is redirected");
  }

  await copyFile(source, target);
  await verifyArtifact(target, { ...record, file: filename });
  await writeFile(`${target}.sha256`, `${record.sha256}  ${filename}\n`);

  return target;
}

/** Resolve a nonempty project path confined to the integration checkout. */
export function ownedProject(root: string, path: string): string {
  const result = resolve(root, path);
  const child = relative(resolve(root), result);

  if (child.startsWith("..") || isAbsolute(child) || !child) {
    throw new Error("Project path escapes integration checkout");
  }

  return result;
}

/** Verify the installed bytes, not merely the checksum of a potentially cached input. */
export async function verifyInstalledPackage(tarball: string, installed: string): Promise<void> {
  const root = await realpath(installed);
  const { stdout } = await tar(["-tzf", resolve(tarball)]);

  const entries = stdout
    .toString("utf8")
    .trim()
    .split(/\r?\n/)
    .filter((name) => !name.endsWith("/"));

  if (!entries.length) {
    throw new Error("Empty package archive");
  }

  const expected = new Set<string>();

  for (const entry of entries) {
    // Archive paths must reject control bytes as well as platform separators.
    if (
      !entry.startsWith("package/") ||
      // eslint-disable-next-line no-control-regex
      /[\\\x00-\x1f]/.test(entry) ||
      entry.split("/").some((part) => part === ".." || part === "." || !part)
    ) {
      throw new Error("Unsafe package archive member");
    }

    const name = entry.slice("package/".length);

    if (expected.has(name)) {
      throw new Error("Duplicate package archive member");
    }

    expected.add(name);

    const file = resolve(root, name);

    if ((await realpath(file)) !== file) {
      throw new Error("Installed package member is redirected");
    }

    const packed = await tar(["-xOf", resolve(tarball), entry]);

    if (!(await readFile(file)).equals(packed.stdout)) {
      throw new Error(`Installed package differs: ${name}`);
    }
  }

  const metadata = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const dependencies = new Set<string>();

  for (const name of Object.keys({
    ...metadata.dependencies,
    ...metadata.optionalDependencies,
    ...metadata.peerDependencies,
  })) {
    if (!/^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) {
      throw new Error("Invalid declared dependency");
    }

    const prefix = `node_modules/${name}`;

    if (![...expected].some((path) => path.startsWith(prefix + "/"))) {
      dependencies.add(prefix);
    }
  }

  const files = await installedFiles(root, "", dependencies);

  if (files.length !== expected.size || files.some((file) => !expected.has(file))) {
    throw new Error("Installed package has unexpected files");
  }
}
