import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import {
  COMMUNITY_IMAGE,
  runName,
  validateFixture,
  validateImage,
  type Fixture,
  type StartOptions,
} from "./manifest.js";
import { acquire, directory, exclusive, readManifest, writePrivate } from "./storage.js";
import { seedAccounts } from "./seed.js";
import { dockerDriver, type Driver } from "./driver.js";

export { readManifest, readFixture, writePrivate } from "./storage.js";

export { COMMUNITY_IMAGE, validateFixture } from "./manifest.js";

export type { Fixture, StartOptions } from "./manifest.js";

/** Inject the container driver and account seeding without changing fixture lifecycle. */
export interface CommunityIO {
  driver: Driver;
  seed: (fixture: Fixture) => Promise<void>;
}

export const communityIO: CommunityIO = {
  driver: dockerDriver,
  seed: seedAccounts,
};

async function prepare(
  options: StartOptions,
  kind: Fixture["kind"],
  io: CommunityIO,
): Promise<Fixture> {
  const owner = await realpath(options.owner);
  const output = resolve(options.output);
  const dir = await directory(dirname(output));

  const id = runName(
    options.id ?? `cloudreve-${createHash("sha256").update(output).digest("hex").slice(0, 20)}`,
  );

  const role = options.role ?? (kind === "ephemeral" ? "test" : "dev");

  if (!["dev", "test"].includes(role)) {
    throw new Error("Invalid fixture role");
  }

  if (kind === "ephemeral" && role !== "test") {
    throw new Error("Ephemeral fixtures require test role");
  }

  const port = options.port ?? 0;

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("Invalid fixture port");
  }

  const corsOrigin = options.corsOrigin ?? "http://localhost";
  const origin = new URL(corsOrigin);

  if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== corsOrigin) {
    throw new Error("Invalid CORS origin");
  }

  const project =
    kind === "ephemeral"
      ? `cloudreve-${randomUUID()}`
      : `cloudreve-${createHash("sha256")
          .update(owner + "\0" + id)
          .digest("hex")
          .slice(0, 20)}`;

  const image = validateImage(options.image ?? COMMUNITY_IMAGE);
  const spec = { owner, id, role, project, port, corsOrigin, image };
  const resources = await io.driver.start(spec, kind === "ephemeral");

  const fixture = validateFixture(
    {
      schemaVersion: 2,
      status: "starting",
      kind,
      ...spec,
      ...resources,
      credentialsFile: resolve(dir, "credentials.json"),
      secondaryCredentialsFile: resolve(dir, "credentials-second.json"),
    },
    owner,
  );

  try {
    await writePrivate(output, fixture);

    if (kind === "persistent") {
      await io.driver.ready(fixture);
    }

    await io.seed(fixture);
    fixture.status = "ready";
    await writePrivate(output, fixture);

    return fixture;
  } catch (error) {
    if (kind === "ephemeral") {
      await io.driver.stop(fixture, true);
    }

    throw error;
  }
}

/** Create a disposable fixture; close the returned lease to remove its owned resources. */
export async function startCommunity(
  options: StartOptions,
  io = communityIO,
): Promise<{ manifest: Fixture; close: () => Promise<void> }> {
  const release = await acquire(dirname(resolve(options.output)));

  try {
    let existing: Fixture | undefined;

    try {
      existing = await readManifest(options.output, await realpath(options.owner));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    if (existing?.kind === "persistent") {
      throw Error("Existing persistent data requires its development lifecycle");
    }

    if (existing && !(await io.driver.absent(existing))) {
      throw Error("Existing ephemeral resources require owner cleanup or recovery");
    }

    const manifest = await prepare(options, "ephemeral", io);

    let closed = false;
    let released = false;

    return {
      manifest,
      async close() {
        try {
          if (!closed) {
            await io.driver.stop(manifest, true);
            closed = true;
          }
        } finally {
          if (!released) {
            released = true;
            await release();
          }
        }
      },
    };
  } catch (error) {
    await release();

    throw error;
  }
}

/** Start or reuse a persistent development fixture without discarding its data. */
export async function startDevelopment(options: StartOptions, io = communityIO): Promise<Fixture> {
  const dir = await directory(dirname(resolve(options.output)));

  return exclusive(dir, async () => {
    let existing: Fixture | undefined;

    try {
      existing = await readManifest(options.output, await realpath(options.owner));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        throw e;
      }
    }

    if (existing?.kind === "ephemeral") {
      throw new Error("Existing ephemeral manifest requires its owner lifecycle");
    }

    if (existing && options.id && options.id !== existing.id) {
      throw new Error("Manifest belongs to another fixture id");
    }

    return prepare(
      {
        ...options,
        ...(existing
          ? {
              id: existing.id,
              image: existing.image,
              role: existing.role,
              port: Number(new URL(existing.endpoint).port),
              corsOrigin: existing.corsOrigin,
            }
          : {}),
      },
      "persistent",
      io,
    );
  });
}

/** Stop a persistent fixture; pass remove only when its data can be discarded. */
export async function stopDevelopment(
  fixture: Fixture,
  remove = false,
  io = communityIO,
): Promise<void> {
  validateFixture(fixture, fixture.owner);

  if (fixture.kind !== "persistent") {
    throw new Error("Ephemeral fixtures are cleaned by their lease owner");
  }

  await exclusive(dirname(fixture.credentialsFile), () => io.driver.stop(fixture, remove));
}

/** Apply an explicit fault or recovery action to the owned fixture. */
export async function controlFixture(
  fixture: Fixture,
  action: "pause" | "unpause" | "restart" | "start" | "stop",
  io = communityIO,
): Promise<void> {
  validateFixture(fixture, fixture.owner);
  await io.driver.control(fixture, action);
}

/** Wait until all resources belonging to the fixture have been removed. */
export async function assertAbsent(
  fixture: Fixture,
  timeoutMs = 0,
  io = communityIO,
): Promise<void> {
  validateFixture(fixture, fixture.owner);

  const deadline = Date.now() + timeoutMs;

  while (!(await io.driver.absent(fixture))) {
    if (Date.now() >= deadline) {
      throw new Error("Fixture resources remain; its lease owner must clean them");
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Recover only an abandoned ephemeral lease; a live owner's heartbeat prevents acquisition. */
export async function recoverCommunity(
  output: string,
  owner: string,
  io = communityIO,
): Promise<void> {
  await exclusive(dirname(resolve(output)), async () => {
    const fixture = await readManifest(output, await realpath(owner));

    if (fixture.kind !== "ephemeral") {
      throw Error("Recovery requires an ephemeral fixture");
    }

    await io.driver.stop(fixture, true);
  });
}
