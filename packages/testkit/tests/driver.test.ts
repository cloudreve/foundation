import fc from "fast-check";
import { beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => {
  const docker = {
    listContainers: vi.fn(),
    listNetworks: vi.fn(),
    listVolumes: vi.fn(),
  };

  const handle = {
    pause: vi.fn(),
    unpause: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };

  const client = {
    container: {
      dockerode: docker,
      inspect: vi.fn(),
      getById: vi.fn(() => handle),
      fetchByLabel: vi.fn(),
      restart: vi.fn(),
    },
    compose: { up: vi.fn(), down: vi.fn(), stop: vi.fn() },
  };

  const stack = {
    getContainer: vi.fn(() => ({ getId: () => "a".repeat(64) })),
  };

  const builder = {
    withProjectName: vi.fn(),
    withEnvironment: vi.fn(),
    withWaitStrategy: vi.fn(),
    withStartupTimeout: vi.fn(),
    up: vi.fn(),
  };

  const wait = {
    forStatusCode: vi.fn(),
    forResponsePredicate: vi.fn(),
    withReadTimeout: vi.fn(),
    withStartupTimeout: vi.fn(),
  };

  return {
    docker,
    handle,
    client,
    stack,
    builder,
    wait,
    waitForContainer: vi.fn(),
    setBinding: vi.fn(),
  };
});

vi.mock("testcontainers", () => ({
  DockerComposeEnvironment: class {
    constructor() {
      return mock.builder;
    }
  },
  getContainerRuntimeClient: async () => mock.client,
  Wait: { forHttp: () => mock.wait },
  BoundPorts: class {
    setBinding = mock.setBinding;
  },
  waitForContainer: mock.waitForContainer,
}));

import { dockerDriver, type Spec } from "../src/driver.js";
import { COMMUNITY_IMAGE, type Fixture } from "../src/manifest.js";

const spec: Spec = {
  owner: "/fixture",
  id: "cloudreve-test",
  role: "test",
  project: "cloudreve-project",
  port: 1234,
  corsOrigin: "http://localhost",
};

const labels = {
  "dev.cloudreve.worktree": spec.owner,
  "dev.cloudreve.fixture": spec.id,
  "dev.cloudreve.role": spec.role,
};

const info = () => ({
  State: { Running: true, Paused: false },
  Id: "a".repeat(64),
  Config: { Labels: labels, Image: COMMUNITY_IMAGE },
  NetworkSettings: {
    Ports: { "5212/tcp": [{ HostIp: "127.0.0.1", HostPort: "1234" }] },
    Networks: { owned: { NetworkID: "network-id" } },
  },
  Mounts: [{ Destination: "/cloudreve/data", Type: "volume", Name: "volume-id" }],
});

const fixture = {
  schemaVersion: 2,
  status: "ready",
  kind: "ephemeral",
  ...spec,
  endpoint: "http://127.0.0.1:1234",
  containerId: "a".repeat(64),
  network: "network-id",
  volume: "volume-id",
  image: COMMUNITY_IMAGE,
  credentialsFile: "/fixture/credentials.json",
  secondaryCredentialsFile: "/fixture/credentials-second.json",
} as Fixture;

beforeEach(() => {
  vi.clearAllMocks();
  mock.docker.listContainers.mockResolvedValue([]);
  mock.docker.listNetworks.mockResolvedValue([]);
  mock.docker.listVolumes.mockResolvedValue({ Volumes: [] });
  mock.client.container.inspect.mockResolvedValue(info());
  mock.client.container.fetchByLabel.mockResolvedValue(mock.handle);
  mock.client.compose.up.mockResolvedValue(undefined);
  mock.client.compose.down.mockResolvedValue(undefined);
  mock.client.compose.stop.mockResolvedValue(undefined);
  mock.waitForContainer.mockResolvedValue(undefined);

  for (const [name, method] of Object.entries(mock.builder)) {
    if (name !== "up") {
      method.mockReturnValue(mock.builder);
    }
  }

  mock.builder.up.mockResolvedValue(mock.stack);

  for (const method of Object.values(mock.wait)) {
    method.mockReturnValue(mock.wait);
  }
});

it("uses managed Compose/HTTP readiness for ephemeral fixtures", async () => {
  const result = await dockerDriver.start(spec, true);

  expect(result).toEqual({
    containerId: "a".repeat(64),
    endpoint: "http://127.0.0.1:1234",
    network: "network-id",
    volume: "volume-id",
  });

  expect(mock.builder.withEnvironment).toHaveBeenCalledWith(
    expect.objectContaining({
      CR_OWNER: "/fixture",
      CR_RUN_ID: "cloudreve-test",
    }),
  );

  const predicate = mock.wait.forResponsePredicate.mock.calls[0]![0];

  expect(predicate('{"code":0}')).toBe(true);
  expect(predicate('{"code":1}')).toBe(false);
  expect(predicate("{")).toBe(false);
});

it("does not use test-container teardown for persistent startup failures", async () => {
  await dockerDriver.start(spec, false);
  expect(mock.client.compose.up).toHaveBeenCalled();
  expect(mock.builder.up).not.toHaveBeenCalled();
  mock.waitForContainer.mockRejectedValue(new Error("not healthy"));
  await expect(dockerDriver.ready(fixture)).rejects.toThrow("not healthy");
  expect(mock.client.compose.down).not.toHaveBeenCalled();
});

it("recovers failed ephemeral startup through owned project teardown", async () => {
  mock.builder.up.mockRejectedValue(new Error("startup failed"));

  await expect(dockerDriver.start(spec, true)).rejects.toThrow("startup failed");

  expect(mock.client.compose.down).toHaveBeenCalledWith(expect.anything(), {
    timeout: 10000,
    removeVolumes: true,
  });
});

it("rejects malformed mapped resources and preserves failed persistent data", async () => {
  mock.client.container.inspect.mockResolvedValue({ ...info(), Mounts: [] });
  await expect(dockerDriver.start(spec, true)).rejects.toThrow("resources");
  expect(mock.client.compose.down).toHaveBeenCalled();
  mock.client.compose.down.mockClear();
  await expect(dockerDriver.start(spec, false)).rejects.toThrow("resources");
  expect(mock.client.compose.down).not.toHaveBeenCalled();
  mock.client.container.fetchByLabel.mockResolvedValue(undefined);

  await expect(dockerDriver.start(spec, false)).rejects.toThrow("did not start");
});

it.each(["container", "network", "volume"])(
  "refuses a foreign %s before teardown",
  async (kind) => {
    if (kind === "container") {
      mock.docker.listContainers.mockResolvedValue([{ Id: "a", Labels: {} }]);
    }

    if (kind === "network") {
      mock.docker.listNetworks.mockResolvedValue([{ Labels: {} }]);
    }

    if (kind === "volume") {
      mock.docker.listVolumes.mockResolvedValue({ Volumes: [{ Labels: {} }] });
    }

    await expect(dockerDriver.stop(fixture, true)).rejects.toThrow("another fixture");

    expect(mock.client.compose.down).not.toHaveBeenCalled();
  },
);

it("checks actual pinned image and owned labels", async () => {
  mock.docker.listContainers.mockResolvedValue([{ Id: "a", Labels: labels }]);
  mock.docker.listNetworks.mockResolvedValue([{ Labels: labels }]);
  mock.docker.listVolumes.mockResolvedValue({ Volumes: [{ Labels: labels }] });
  await dockerDriver.stop(fixture, false);

  expect(mock.client.compose.stop).toHaveBeenCalledWith(
    expect.not.objectContaining({ commandOptions: expect.anything() }),
  );

  mock.client.container.inspect.mockResolvedValue({
    ...info(),
    Config: { Labels: labels, Image: "other" },
  });

  await expect(dockerDriver.stop(fixture, true)).rejects.toThrow("pinned image");
});

it("supports scoped fault injection and absence checks", async () => {
  await dockerDriver.control(fixture, "pause");

  mock.client.container.inspect.mockResolvedValue({
    ...info(),
    State: { Running: true, Paused: true },
  });

  await dockerDriver.control(fixture, "unpause");
  await dockerDriver.control(fixture, "restart");
  expect(mock.handle.pause).toHaveBeenCalled();
  expect(mock.handle.unpause).toHaveBeenCalled();
  expect(mock.client.container.restart).toHaveBeenCalled();
  expect(await dockerDriver.absent(fixture)).toBe(true);
  mock.docker.listContainers.mockResolvedValue([{}]);
  expect(await dockerDriver.absent(fixture)).toBe(false);
  mock.docker.listContainers.mockResolvedValue([]);
  mock.docker.listNetworks.mockResolvedValue([{}]);
  expect(await dockerDriver.absent(fixture)).toBe(false);
  mock.docker.listNetworks.mockResolvedValue([]);
  mock.docker.listVolumes.mockResolvedValue({ Volumes: [{}] });
  expect(await dockerDriver.absent(fixture)).toBe(false);
  mock.docker.listVolumes.mockResolvedValue({ Volumes: null });
  expect(await dockerDriver.absent(fixture)).toBe(true);

  mock.client.container.inspect.mockResolvedValue({
    ...info(),
    Config: { Labels: labels, Image: "foreign" },
  });

  await expect(dockerDriver.control(fixture, "pause")).rejects.toThrow("pinned image");
});

it("makes fault restoration idempotent and preserves resources during stop/start", async () => {
  for (const running of [true, false]) {
    for (const paused of [true, false]) {
      mock.client.container.inspect.mockResolvedValue({
        ...info(),
        State: { Running: running, Paused: paused },
      });

      for (const action of ["start", "stop", "pause", "unpause"] as const) {
        await dockerDriver.control(fixture, action);
      }
    }
  }

  expect(mock.handle.start).toHaveBeenCalledTimes(2);
  expect(mock.handle.stop).toHaveBeenCalledTimes(2);
  expect(mock.handle.pause).toHaveBeenCalledTimes(2);
  expect(mock.handle.unpause).toHaveBeenCalledTimes(2);
  expect(mock.client.compose.down).not.toHaveBeenCalled();
});

it("refuses any single ownership-label mismatch before touching a resource", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom("dev.cloudreve.worktree", "dev.cloudreve.fixture", "dev.cloudreve.role"),
      fc.string().filter((value) => !Object.values(labels).includes(value)),
      async (key, value) => {
        mock.docker.listContainers.mockResolvedValue([
          { Id: "a", Labels: { ...labels, [key]: value } },
        ]);

        await expect(dockerDriver.stop(fixture, true)).rejects.toThrow("another fixture");

        expect(mock.client.compose.down).not.toHaveBeenCalled();
      },
    ),
    { numRuns: 50 },
  );
});

it("binds a concrete host port so outage recovery preserves the endpoint", async () => {
  await dockerDriver.start({ ...spec, port: 0 }, true);

  const port = Number(mock.builder.withEnvironment.mock.calls[0]![0].CR_BACKEND_PORT);

  expect(port).toBeGreaterThan(0);
  expect(port).toBeLessThanOrEqual(65535);
});

it("verifies the explicitly pinned source image instead of silently using the release", async () => {
  const image = "sha256:" + "b".repeat(64);
  const custom = { ...fixture, image };

  mock.client.container.inspect.mockResolvedValue({
    ...info(),
    Config: { Labels: labels, Image: image },
  });

  mock.docker.listContainers.mockResolvedValue([{ Id: "a", Labels: labels }]);
  await dockerDriver.start({ ...spec, image }, true);

  expect(mock.builder.withEnvironment).toHaveBeenCalledWith(
    expect.objectContaining({ CR_IMAGE: image }),
  );

  await dockerDriver.control(custom, "restart");
  await dockerDriver.stop(custom, true);
});
