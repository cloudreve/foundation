import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parityServices } from "../src/parity-services.js";
import { oauthFixture } from "../src/oauth-fixture.js";
import { metadataFixture } from "../src/metadata-fixture.js";
import { encryptionFixture } from "../src/encryption-fixture.js";
import { COMMUNITY_IMAGE, type Fixture, type FixtureRequest } from "../src/manifest.js";

const mock = vi.hoisted(() => ({
  failWrite: false,
  exec: vi.fn(),
  up: vi.fn(),
  down: vi.fn(),
  waits: vi.fn(),
  projects: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFileSync: mock.exec }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();

  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (mock.failWrite) {
        throw Error("setup failed");
      }

      return actual.writeFileSync(...args);
    },
  };
});

vi.mock("testcontainers", () => ({
  DockerComposeEnvironment: class {
    withProjectName(name: string) {
      mock.projects(name);

      return this;
    }

    withWaitStrategy(name: string, strategy: unknown) {
      mock.waits(name, strategy);

      return this;
    }

    withStartupTimeout() {
      return this;
    }

    up() {
      return mock.up();
    }
  },
  Wait: { forHttp: (path: string, port: number) => ({ path, port }) },
}));

let dir: string;
let fixture: Fixture;

function labels() {
  return {
    "dev.cloudreve.worktree": dir,
    "dev.cloudreve.role": "test",
    "dev.cloudreve.fixture": "parity",
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  mock.failWrite = false;
  dir = await mkdtemp(join(tmpdir(), "cloudreve-parity-"));

  fixture = {
    schemaVersion: 2,
    status: "ready",
    kind: "ephemeral",
    id: "parity",
    owner: dir,
    role: "test",
    project: "parity-project",
    image: COMMUNITY_IMAGE,
    endpoint: "http://127.0.0.1:4000",
    containerId: "a".repeat(64),
    network: "owned-network",
    volume: "owned-volume",
    credentialsFile: join(dir, "credentials.json"),
    secondaryCredentialsFile: join(dir, "second.json"),
    corsOrigin: "http://localhost",
  };

  mock.exec.mockImplementation((command: string, args: string[]) => {
    if (command === "docker" && args[0] === "inspect") {
      return JSON.stringify([
        args[1] === fixture.containerId ? { Config: { Labels: labels() } } : { Labels: labels() },
      ]);
    }

    return "";
  });

  mock.down.mockResolvedValue(undefined);

  mock.up.mockResolvedValue({
    down: mock.down,
    getContainer: () => ({ getMappedPort: (port: number) => port + 10000 }),
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function requests() {
  const writes: Record<string, string>[] = [];

  const request = vi.fn<FixtureRequest>(async (_path, options) => {
    const data = JSON.parse(options?.body ?? "{}");

    if (options?.method === "POST") {
      return { smtpHost: "original", email_active: "1" };
    }

    writes.push(data.settings);

    return {};
  });

  return { request, writes };
}

it("uses managed private-port services and applies/restores each setting without losing reloads", async () => {
  const { request, writes } = requests();
  const services = await parityServices(fixture, request);

  expect(services.mail).toBe("http://127.0.0.1:18025");
  expect(services.search).toBe("http://127.0.0.1:17700");
  expect(services.extractor).toBe("http://127.0.0.1:19998");
  expect(mock.waits).toHaveBeenCalledTimes(3);

  const [folder] = await readdir(dir);

  const compose = JSON.parse(await readFile(join(dir, folder!, "compose.json"), "utf8"));

  expect(compose.networks.fixture).toEqual({
    external: true,
    name: fixture.network,
  });

  for (const service of Object.values(compose.services) as {
    ports: string[];
    labels: unknown;
  }[]) {
    expect(service.ports[0]).toMatch(/^127\.0\.0\.1::/);
    expect(service.labels).toEqual(labels());
  }

  expect(compose.services.mail.environment.MP_SMTP_TLS_CERT).toBe("/tls/cert.crt");

  expect(writes.every((x) => Object.keys(x).length === 1)).toBe(true);
  await services.set({ email_active: "1", use_sse_for_search: "1" });
  await services.close();
  await services.close();
  expect(mock.down).toHaveBeenCalledTimes(1);
  expect(await readdir(dir)).toEqual([]);
  expect(writes).toContainEqual({ smtpHost: "original" });
  expect(writes).toContainEqual({ email_active: "1" });
  expect(writes).toContainEqual({ fts_enabled: "" });
});

it("rejects persistent/dev/foreign containers and malformed ownership before starting services", async () => {
  const { request } = requests();

  await expect(parityServices({ ...fixture, kind: "persistent" }, request)).rejects.toThrow();

  await expect(parityServices({ ...fixture, role: "dev" }, request)).rejects.toThrow();

  mock.exec.mockReturnValue(
    JSON.stringify([
      {
        Config: {
          Labels: { ...labels(), "dev.cloudreve.worktree": "foreign" },
        },
      },
    ]),
  );

  await expect(parityServices(fixture, request)).rejects.toThrow();

  mock.exec.mockReturnValue(JSON.stringify([{ Config: { Labels: null }, Labels: null }]));

  await expect(parityServices(fixture, request)).rejects.toThrow();
  mock.exec.mockReturnValue("null");
  await expect(parityServices(fixture, request)).rejects.toThrow();
  expect(mock.up).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
  expect(await readdir(dir)).toEqual([]);
});

it.each(["openssl", "cp", "write-config"])(
  "cleans temporary material when setup fails at %s",
  async (stage) => {
    mock.failWrite = stage === "write-config";

    const original = mock.exec.getMockImplementation()!;

    mock.exec.mockImplementation((command: string, args: string[]) => {
      if (command === stage || (stage === "cp" && args[0] === "cp")) {
        throw Error("setup failed");
      }

      return original(command, args);
    });

    await expect(parityServices(fixture, requests().request)).rejects.toThrow("setup failed");

    expect(await readdir(dir)).toEqual([]);
    expect(mock.up).not.toHaveBeenCalled();
  },
);

it("tears down the owned Compose project if startup fails before a handle exists", async () => {
  mock.up.mockRejectedValueOnce(Error("startup failed"));

  await expect(parityServices(fixture, requests().request)).rejects.toThrow("startup failed");

  expect(
    mock.exec.mock.calls.some(
      ([command, args]) =>
        command === "docker" && args[0] === "compose" && args.at(-1) === "--volumes",
    ),
  ).toBe(true);

  expect(await readdir(dir)).toEqual([]);
});

it("closes started services on snapshot/read or partial settings failures", async () => {
  await expect(
    parityServices(fixture, async () => {
      throw Error("read failed");
    }),
  ).rejects.toThrow("read failed");

  expect(mock.down).toHaveBeenCalledTimes(1);

  const { request } = requests();
  let failed = false;

  const wrapped: FixtureRequest = async (path, options) => {
    if (options?.method === "PATCH" && !failed) {
      failed = true;

      throw Error("patch failed");
    }

    return request(path, options);
  };

  await expect(parityServices(fixture, wrapped)).rejects.toThrow("patch failed");

  expect(mock.down).toHaveBeenCalledTimes(2);
  expect(await readdir(dir)).toEqual([]);
});

it("still releases services when settings restoration fails, and permits retrying a failed down", async () => {
  const { request } = requests();
  const services = await parityServices(fixture, request);

  request.mockRejectedValueOnce(Error("restore failed"));
  await expect(services.close()).rejects.toThrow("restore failed");
  expect(mock.down).toHaveBeenCalledTimes(1);

  const next = await parityServices(fixture, requests().request);

  mock.down.mockRejectedValueOnce(Error("down failed"));
  await expect(next.close()).rejects.toThrow("down failed");
  await next.close();
  expect(await readdir(dir)).toEqual([]);
});

it("creates scoped OAuth fixtures with generated secrets and caller-owned loopback callbacks", async () => {
  const request = vi.fn<FixtureRequest>(async () => ({ id: 8 }));

  const first = await oauthFixture(request);

  const second = await oauthFixture(request, {
    redirectUri: "http://127.0.0.1:9876/callback/nonce",
  });

  expect(first.credentials.clientSecret).not.toBe(second.credentials.clientSecret);

  expect(first.credentials.redirectUri).toBe("http://localhost/fixture-callback");

  expect(second.credentials.redirectUri).toBe("http://127.0.0.1:9876/callback/nonce");

  expect(JSON.parse(request.mock.calls[1]![1]!.body!).client.redirect_uris).toEqual([
    second.credentials.redirectUri,
  ]);

  await first.close();

  expect(request).toHaveBeenLastCalledWith("/api/v4/admin/oauthClient/8", {
    method: "DELETE",
  });

  for (const redirectUri of [
    "https://localhost/x",
    "http://external.test/x",
    "http://user@localhost/x",
    "http://:password@localhost/x",
    "not-url",
  ]) {
    await expect(oauthFixture(request, { redirectUri })).rejects.toThrow();
  }

  await expect(oauthFixture(async () => ({ id: 0 }))).rejects.toThrow();
});

it("preserves encrypted policy fields, forces nonaligned chunks and restores the original policy", async () => {
  const original = {
    id: 1,
    name: "Original",
    settings: { relay: true, chunk_size: 1024 },
  };

  const request = vi.fn<FixtureRequest>(async () => original);

  const close = await encryptionFixture(request);

  expect(JSON.parse(request.mock.calls[1]![1]!.body!).policy).toEqual({
    ...original,
    settings: { ...original.settings, encryption: true, chunk_size: 524291 },
  });

  await close();
  expect(JSON.parse(request.mock.calls[2]![1]!.body!).policy).toEqual(original);

  const absent = vi.fn<FixtureRequest>(async () => ({ id: 1 }));

  await (
    await encryptionFixture(absent)
  )();

  await expect(encryptionFixture(async () => null)).rejects.toThrow();
});

it("seeds all property types without removing existing definitions, then restores settings", async () => {
  const original = {
    custom_props: JSON.stringify([
      { id: "other", type: "text" },
      { id: "parity_text", type: "rating" },
    ]),
    emojis: JSON.stringify({ existing: ["😀"] }),
  };

  const request = vi.fn<FixtureRequest>(async () => original);
  const result = await metadataFixture(request);

  expect(result.properties.map((x) => x.type)).toEqual([
    "text",
    "number",
    "boolean",
    "select",
    "multi_select",
    "link",
    "rating",
  ]);

  const installed = JSON.parse(JSON.parse(request.mock.calls[1]![1]!.body!).settings.custom_props);

  expect(installed).toHaveLength(8);
  expect(installed[0].id).toBe("other");

  expect(JSON.parse(JSON.parse(request.mock.calls[2]![1]!.body!).settings.emojis)).toEqual({
    existing: ["😀"],
    parity: ["📁", "🎵"],
  });

  await result.close();

  expect(JSON.parse(request.mock.calls.at(-2)![1]!.body!).settings).toEqual({
    custom_props: original.custom_props,
  });

  await (await metadataFixture(async () => ({}))).close();

  const failing = vi
    .fn<FixtureRequest>()
    .mockResolvedValueOnce(original)
    .mockRejectedValueOnce(Error("write failed"))
    .mockResolvedValue({});

  await expect(metadataFixture(failing)).rejects.toThrow("write failed");
  expect(failing).toHaveBeenCalledTimes(4);

  const restore = await metadataFixture(request);

  request.mockRejectedValueOnce(Error("restore failed"));
  await expect(restore.close()).rejects.toThrow("restore failed");

  expect(JSON.parse(request.mock.calls.at(-1)![1]!.body!).settings).toEqual({
    emojis: original.emojis,
  });

  await expect(metadataFixture(async () => ({ custom_props: "{}" }))).rejects.toThrow();
});
