import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  realpath,
  rm,
  readFile,
  writeFile,
  mkdir,
  symlink,
  chmod,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startCommunity,
  startDevelopment,
  stopDevelopment,
  controlFixture,
  assertAbsent,
  recoverCommunity,
  type CommunityIO,
} from "../src/community.js";
import {
  directory,
  readFixture,
  readManifest,
  readPrivate,
  writePrivate,
  exclusive,
} from "../src/storage.js";
import {
  validateFixture,
  validateCredentialPaths,
  runName,
  COMMUNITY_IMAGE,
  type Fixture,
} from "../src/manifest.js";

let owner: string;

beforeEach(async () => {
  owner = await realpath(await mkdtemp(join(tmpdir(), "testkit-lifecycle-")));
});

afterEach(async () => {
  await rm(owner, { recursive: true, force: true });
  vi.useRealTimers();
});

function harness() {
  const driver = {
    start: vi.fn(async () => ({
      containerId: "a".repeat(64),
      endpoint: "http://127.0.0.1:25000",
      network: "opaque-network",
      volume: "opaque-volume",
    })),
    stop: vi.fn(async () => {}),
    ready: vi.fn(async () => {}),
    control: vi.fn(async () => {}),
    absent: vi.fn(async () => true),
  };

  const seed = vi.fn(async () => {});

  return { driver, seed, io: { driver, seed } as CommunityIO };
}

function fixture(): Fixture {
  return {
    schemaVersion: 2,
    status: "ready",
    kind: "persistent",
    id: "owned",
    owner,
    role: "dev",
    project: "owned-project",
    image: COMMUNITY_IMAGE,
    endpoint: "http://127.0.0.1:25000",
    containerId: "a".repeat(64),
    network: "opaque-network",
    volume: "opaque-volume",
    credentialsFile: join(owner, "credentials.json"),
    secondaryCredentialsFile: join(owner, "second.json"),
    corsOrigin: "http://localhost",
  };
}

it("owns ephemeral assembly, readiness publication and idempotent cleanup", async () => {
  const h = harness();
  const output = join(owner, "run", "fixture.json");

  const lease = await startCommunity({ owner, output }, h.io);

  expect(h.driver.start).toHaveBeenCalledWith(
    expect.objectContaining({ owner, role: "test", port: 0 }),
    true,
  );

  expect(h.driver.ready).not.toHaveBeenCalled();
  expect(h.seed).toHaveBeenCalledOnce();
  expect(await readFixture(output, owner)).toEqual(lease.manifest);
  expect(lease.manifest.network).toBe("opaque-network");

  if (process.platform !== "win32") {
    expect((await stat(output)).mode & 0o777).toBe(0o600);
  }

  await expect(startCommunity({ owner, output }, h.io)).rejects.toThrow();
  await controlFixture(lease.manifest, "pause", h.io);
  expect(h.driver.control).toHaveBeenCalledWith(lease.manifest, "pause");

  await expect(stopDevelopment(lease.manifest, true, h.io)).rejects.toThrow("lease owner");

  await lease.close();
  await lease.close();
  expect(h.driver.stop).toHaveBeenCalledTimes(1);
  expect(h.driver.stop).toHaveBeenCalledWith(lease.manifest, true);

  const second = await startCommunity({ owner, output }, h.io);

  expect(second.manifest.project).not.toBe(lease.manifest.project);
  await second.close();
});

it("cleans failed ephemeral seeding and permits a subsequent owned run", async () => {
  const h = harness();
  const output = join(owner, "fixture.json");

  h.seed.mockRejectedValueOnce(Error("seed rejected"));

  await expect(startCommunity({ owner, output }, h.io)).rejects.toThrow("seed rejected");

  expect(h.driver.stop).toHaveBeenCalledOnce();
  await expect(readFixture(output, owner)).rejects.toThrow("not ready");
  expect((await readManifest(output, owner)).status).toBe("starting");

  const lease = await startCommunity({ owner, output }, h.io);

  await lease.close();
});

it("retains persistent resources after failed readiness and restores their original port and identity", async () => {
  const h = harness();
  const output = join(owner, "fixture.json");

  h.driver.ready.mockRejectedValueOnce(Error("not ready"));

  await expect(
    startDevelopment(
      {
        owner,
        output,
        id: "devbox",
        port: 25000,
        corsOrigin: "http://localhost:8000",
      },
      h.io,
    ),
  ).rejects.toThrow("not ready");

  expect(h.driver.stop).not.toHaveBeenCalled();
  expect(h.seed).not.toHaveBeenCalled();

  const recovered = await startDevelopment(
    { owner, output, port: 26000, corsOrigin: "http://localhost:9000" },
    h.io,
  );

  expect(h.driver.start.mock.calls[1]?.[0]).toMatchObject({
    id: "devbox",
    role: "dev",
    port: 25000,
    corsOrigin: "http://localhost:8000",
  });

  expect(recovered.kind).toBe("persistent");
  await stopDevelopment(recovered, false, h.io);
  expect(h.driver.stop).toHaveBeenLastCalledWith(recovered, false);
  await stopDevelopment(recovered, true, h.io);
  expect(h.driver.stop).toHaveBeenLastCalledWith(recovered, true);

  await expect(startDevelopment({ owner, output, id: "different" }, h.io)).rejects.toThrow(
    "another fixture id",
  );
});

it("refuses adopting ephemeral state and releases locks after start and close failures", async () => {
  const h = harness();
  const output = join(owner, "fixture.json");

  h.driver.start.mockRejectedValueOnce(Error("engine down"));

  await expect(startCommunity({ owner, output }, h.io)).rejects.toThrow("engine down");

  const lease = await startCommunity({ owner, output }, h.io);

  h.driver.stop.mockRejectedValueOnce(Error("cleanup pending"));
  await expect(lease.close()).rejects.toThrow("cleanup pending");
  await lease.close();

  await expect(startDevelopment({ owner, output }, h.io)).rejects.toThrow("ephemeral");
});

it.each([
  { role: "dev" as const },
  { port: -1 },
  { port: 65536 },
  { port: 1.5 },
  { corsOrigin: "https://host/path" },
  { corsOrigin: "file:///tmp" },
  { id: "../other" },
])("refuses invalid start options before creating resources: %j", async (patch) => {
  const h = harness();

  await expect(
    startCommunity({ owner, output: join(owner, "fixture.json"), ...patch }, h.io),
  ).rejects.toThrow();

  expect(h.driver.start).not.toHaveBeenCalled();
});

it("validates opaque manifests, adjacent credential paths and private storage without following redirects", async () => {
  const value = fixture();
  const path = join(owner, "fixture.json");

  await writePrivate(path, value);
  expect(await readFixture(path, owner)).toEqual(value);
  expect(() => validateFixture(value, "/other")).toThrow("another project");

  for (const patch of [
    { schemaVersion: 1 },
    { containerId: "name" },
    { endpoint: "https://external.test" },
    { project: "../x" },
    { image: "latest" },
  ]) {
    expect(() => validateFixture({ ...value, ...patch }, owner)).toThrow();
  }

  for (const field of ["credentialsFile", "secondaryCredentialsFile"]) {
    expect(() =>
      validateCredentialPaths({ ...value, [field]: "/other/credentials.json" }, path),
    ).toThrow("outside");
  }

  expect(runName("safe_123")).toBe("safe_123");
  expect(() => runName("bad/name")).toThrow();
  await writeFile(path, "{", { mode: 0o600 });
  await expect(readPrivate(path)).rejects.toThrow();

  if (process.platform !== "win32") {
    await chmod(path, 0o644);
    await expect(readPrivate(path)).rejects.toThrow("private");
  }

  await mkdir(join(owner, "actual"));
  await symlink(join(owner, "actual"), join(owner, "redirect"), "junction");

  await expect(directory(join(owner, "redirect"))).rejects.toThrow("Redirected");

  const link = join(owner, "link.json");

  await symlink(path, link);
  await expect(writePrivate(link, {})).rejects.toThrow("redirected");
  await expect(readPrivate(link)).rejects.toThrow("private");

  await expect(writePrivate(join(owner, "actual"), {})).rejects.toThrow("redirected");

  await expect(
    exclusive(owner, async () => {
      throw Error("transaction failed");
    }),
  ).rejects.toThrow("transaction failed");

  expect(await exclusive(owner, async () => 42)).toBe(42);
});

it("reports absent resources and bounds waiting for lease-owner cleanup", async () => {
  const h = harness();
  const value = fixture();

  await assertAbsent(value, 0, h.io);
  h.driver.absent.mockResolvedValue(false);
  await expect(assertAbsent(value, 0, h.io)).rejects.toThrow("remain");
  h.driver.absent.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  vi.useFakeTimers();

  const pending = assertAbsent(value, 1000, h.io);

  await vi.advanceTimersByTimeAsync(250);
  await pending;
  expect(h.driver.absent).toHaveBeenCalled();
});

it("retains persistent data on seeding failure and propagates unreadable saved manifests", async () => {
  const h = harness();
  const output = join(owner, "fixture.json");

  h.seed.mockRejectedValueOnce(Error("seed failed"));

  await expect(startDevelopment({ owner, output }, h.io)).rejects.toThrow("seed failed");

  expect(h.driver.stop).not.toHaveBeenCalled();
  await writeFile(output, "broken", { mode: 0o600 });
  await expect(startDevelopment({ owner, output }, h.io)).rejects.toThrow();
  expect(h.driver.start).toHaveBeenCalledTimes(1);
  expect(await readFile(output, "utf8")).toBe("broken");
});

it("recovers only abandoned ephemeral resources without taking a live lease", async () => {
  const h = harness();
  const output = join(owner, "fixture.json");

  const lease = await startCommunity({ owner, output }, h.io);

  await expect(recoverCommunity(output, owner, h.io)).rejects.toThrow();
  expect(h.driver.stop).not.toHaveBeenCalled();
  await lease.close();
  await recoverCommunity(output, owner, h.io);
  expect(h.driver.stop).toHaveBeenCalledTimes(2);
  await writePrivate(output, { ...lease.manifest, kind: "persistent" });

  await expect(recoverCommunity(output, owner, h.io)).rejects.toThrow("ephemeral");
});

it("keeps an explicit immutable source image across persistent restarts", async () => {
  const h = harness();
  const output = join(owner, "fixture.json");
  const image = "sha256:" + "b".repeat(64);

  const fixture = await startDevelopment({ owner, output, image }, h.io);

  expect(fixture.image).toBe(image);

  expect(h.driver.start).toHaveBeenCalledWith(expect.objectContaining({ image }), false);

  expect((await startDevelopment({ owner, output, image: COMMUNITY_IMAGE }, h.io)).image).toBe(
    image,
  );

  await expect(
    startCommunity(
      {
        owner,
        output: join(owner, "invalid", "fixture.json"),
        image: "cloudreve:latest",
      },
      h.io,
    ),
  ).rejects.toThrow();
});

it("never overwrites persistent or orphaned ephemeral ownership metadata", async () => {
  const h = harness();
  const output = join(owner, "fixture.json");

  await startDevelopment({ owner, output }, h.io);

  const persistent = await readFile(output, "utf8");

  await expect(startCommunity({ owner, output }, h.io)).rejects.toThrow("persistent");

  expect(await readFile(output, "utf8")).toBe(persistent);

  const ephemeralOutput = join(owner, "ephemeral", "fixture.json");
  const lease = await startCommunity({ owner, output: ephemeralOutput }, h.io);

  h.driver.stop.mockRejectedValueOnce(Error("cleanup failed"));
  await expect(lease.close()).rejects.toThrow("cleanup failed");
  h.driver.absent.mockResolvedValue(false);

  const orphan = await readFile(ephemeralOutput, "utf8");

  await expect(startCommunity({ owner, output: ephemeralOutput }, h.io)).rejects.toThrow(
    "recovery",
  );

  expect(await readFile(ephemeralOutput, "utf8")).toBe(orphan);
  await recoverCommunity(ephemeralOutput, owner, h.io);
  h.driver.absent.mockResolvedValue(true);

  await (await startCommunity({ owner, output: ephemeralOutput }, h.io)).close();

  await writeFile(ephemeralOutput, "broken", { mode: 0o600 });

  await expect(startCommunity({ owner, output: ephemeralOutput }, h.io)).rejects.toThrow();
});
