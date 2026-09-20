import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";

const realFetch = globalThis.fetch;

const state = vi.hoisted(() => ({
  calls: [] as string[][],
  resources: {} as Record<string, Record<string, any>>,
  foreignVolume: false,
  failCreate: false,
  failServiceRemoval: false,
  count: 0,
  container: true,
  endpoint: "unix:///var/run/docker.sock",
  publicBinding: false,
  nextPort: "",
  spawnError: false,
  exited: false,
}));

vi.mock("node:fs/promises", () => ({ writeFile: vi.fn() }));

vi.mock("node:fs", () => ({ existsSync: () => state.container }));

vi.spyOn(process, "platform", "get").mockReturnValue("linux");

vi.mock("node:os", () => ({ hostname: () => "aaaaaaaaaaaa" }));
vi.mock("node:timers/promises", () => ({ setTimeout: async () => {} }));

vi.mock("node:child_process", () => ({
  spawnSync: (_command: string, args: string[]) => {
    state.calls.push(args);

    if (state.spawnError) {
      return { error: new Error("spawn failed") };
    }

    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });

    const fail = (stderr: string) => ({ status: 1, stdout: "", stderr });

    const labels: Record<string, string> = {};

    args.forEach((value, index) => {
      if (value === "--label") {
        const raw = args[index + 1]!;
        const split = raw.indexOf("=");

        labels[raw.slice(0, split)] = raw.slice(split + 1);
      }
    });

    const runner = state.resources.container!["a".repeat(64)];

    if (args[0] === "context") {
      return ok(state.endpoint);
    }

    if (args[1] === "inspect") {
      const id = args[2] === "aaaaaaaaaaaa" ? "a".repeat(64) : args[2]!;
      const info = state.resources[args[0]!]?.[id];

      return info ? ok(JSON.stringify([info])) : fail("No such object");
    }

    if (args[0] === "network" && args[1] === "create") {
      const id = args.at(-1)!;

      state.resources.network![id] = {
        Name: id,
        Labels: labels,
        Containers: {},
        IPAM: { Config: [{ Gateway: "127.0.0.1" }] },
      };

      return ok(id);
    }

    if (args[0] === "network" && args[1] === "connect") {
      const id = args[2]!;

      state.resources.network![id].Containers[runner.Id] = {};
      runner.NetworkSettings.Networks[id] = { IPAddress: "127.0.0.1" };

      return ok();
    }

    if (args[0] === "network" && args[1] === "disconnect") {
      delete state.resources.network![args[3]!].Containers[args[4]!];

      return ok();
    }

    if (args[0] === "volume" && args[1] === "create") {
      const id = args.at(-1)!;

      state.resources.volume![id] = {
        Name: id,
        Labels: state.foreignVolume ? { ...labels, "dev.cloudreve.worktree": "/foreign" } : labels,
      };

      return ok(id);
    }

    if (args[0] === "create") {
      if (state.failCreate) {
        return fail("creation failed");
      }

      const id = String.fromCharCode(98 + state.count++).repeat(64);
      const network = args[args.indexOf("--network") + 1]!;

      state.resources.container![id] = {
        Id: id,
        Image: args.at(-1),
        Config: { Image: args.at(-1), Labels: labels },
        State: { Running: false },
        NetworkSettings: {
          Networks: { [network]: { IPAddress: "127.0.0.1" } },
          Ports: args.includes("--publish")
            ? {
                [args[args.indexOf("--publish") + 1]!.split("::")[1] + "/tcp"]: [
                  {
                    HostIp: state.publicBinding ? "0.0.0.0" : "127.0.0.1",
                    HostPort: "56123",
                  },
                ],
              }
            : {},
        },
      };

      state.resources.image![args.at(-1)!] = {
        Os: "linux",
        Architecture: "amd64",
      };

      state.resources.network![network].Containers[id] = {};

      return ok(id);
    }

    if (["start", "restart", "stop"].includes(args[0]!)) {
      const container = state.resources.container![args[1]!];

      container.State.Running = args[0] !== "stop" && !state.exited;

      if (state.nextPort && args[0] !== "stop") {
        container.NetworkSettings.Ports["5212/tcp"][0].HostPort = state.nextPort;
      }

      return ok();
    }

    if (args[0] === "rm") {
      const id = args.at(-1)!;

      if (state.failServiceRemoval && id.startsWith("c")) {
        return fail("transient removal failure");
      }

      delete state.resources.container![id];

      for (const network of Object.values(state.resources.network!)) {
        delete network.Containers[id];
      }

      return ok();
    }

    if (args[1] === "rm") {
      const id = args.at(-1)!;

      if (args[0] === "network" && Object.keys(state.resources.network![id].Containers).length) {
        return fail("network still attached");
      }

      delete state.resources[args[0]!]![id];

      return ok();
    }

    return ok();
  },
}));

import { linuxDockerDriver, docker, requireLinux } from "../src/linux-docker.js";

const spec = {
  owner: "/work/cli",
  id: "fixture-test",
  role: "test" as const,
  project: "fixture-project",
  image: `example@sha256:${"d".repeat(64)}`,
  port: 0,
  corsOrigin: "http://localhost",
};

beforeEach(() => {
  state.calls = [];
  state.count = 0;
  state.spawnError = false;
  state.exited = false;
  state.container = true;
  state.endpoint = "unix:///var/run/docker.sock";
  state.publicBinding = false;
  state.nextPort = "";
  vi.stubEnv("DOCKER_HOST", undefined);
  vi.stubEnv("DOCKER_CONTEXT", undefined);
  state.foreignVolume = false;
  state.failCreate = false;
  state.failServiceRemoval = false;

  state.resources = {
    container: {
      ["a".repeat(64)]: {
        Id: "a".repeat(64),
        State: { Running: true },
        NetworkSettings: { Networks: {} },
      },
    },
    network: {},
    volume: {},
    image: {},
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}")),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("refuses a preexisting foreign volume before attaching it to a backend", async () => {
  state.foreignVolume = true;

  const io = linuxDockerDriver("ci-test");

  await expect(io.driver.start(spec, true)).rejects.toThrow();
  expect(state.calls.some((args) => args[0] === "create")).toBe(false);
  expect(state.calls.some((args) => args[0] === "volume" && args[1] === "rm")).toBe(false);
  expect(Object.keys(state.resources.network!)).toHaveLength(0);
});

it("removes owned resources after partial creation or readiness failure", async () => {
  for (const failReady of [false, true]) {
    state.failCreate = !failReady;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 503 })),
    );

    const io = linuxDockerDriver("ci-test");

    await expect(io.driver.start(spec, true)).rejects.toThrow();
    expect(Object.keys(state.resources.network!)).toHaveLength(0);
    expect(Object.keys(state.resources.volume!)).toHaveLength(0);
    expect(Object.keys(state.resources.container!)).toEqual(["a".repeat(64)]);
    expect(() => io.runnerAddress({ containerId: "b".repeat(64) } as never)).toThrow();
  }
});

it("attempts all cleanup after a sidecar failure, then retries without touching foreign resources", async () => {
  const io = linuxDockerDriver("ci-test");
  const resources = await io.driver.start(spec, true);
  const fixture = { ...spec, ...resources } as never;

  await io.service(fixture, { name: "sidecar", image: spec.image, port: 8025 });

  const before = state.calls.length;

  await expect(
    io.driver.stop({ ...spec, ...resources, owner: "/foreign" } as never, true),
  ).rejects.toThrow("Foreign fixture owner");

  expect(state.calls.slice(before).some((args) => args[0] === "rm")).toBe(false);

  state.resources.container![resources.containerId].Config.Labels["dev.cloudreve.ci-run"] =
    "foreign-run";

  await expect(io.driver.stop(fixture, true)).rejects.toThrow("Foreign CI run");
  expect(state.calls.slice(before).some((args) => args[0] === "rm")).toBe(false);

  state.resources.container![resources.containerId].Config.Labels["dev.cloudreve.ci-run"] =
    "ci-test";

  state.failServiceRemoval = true;
  await expect(io.driver.stop(fixture, true)).rejects.toThrow("cleanup failed");
  expect(state.resources.container![resources.containerId]).toBeUndefined();
  expect(state.resources.volume![resources.volume]).toBeUndefined();
  state.failServiceRemoval = false;
  await io.driver.stop(fixture, true);
  expect(await io.driver.absent(fixture)).toBe(true);
  expect(Object.keys(state.resources.container!)).toEqual(["a".repeat(64)]);
});

it("uses private published ports and the owned host gateway without attaching a native runner", async () => {
  state.container = false;

  const io = linuxDockerDriver("native-test");
  const resources = await io.driver.start({ ...spec, project: "native-project" }, true);
  const fixture = { ...spec, project: "native-project", ...resources } as never;

  await io.service(fixture, { name: "search", image: spec.image, port: 7700 });
  expect(io.runnerAddress(fixture)).toBe("127.0.0.1");

  const creates = state.calls.filter((args) => args[0] === "create");

  expect(creates[0]).toContain("127.0.0.1::5212");
  expect(creates[1]).toContain("127.0.0.1::7700");

  expect(state.calls.some((args) => args[0] === "container" && args[2] === "aaaaaaaaaaaa")).toBe(
    false,
  );

  await io.driver.stop(fixture, true);
  expect(await io.driver.absent(fixture)).toBe(true);

  expect(
    state.calls.some(
      (args) => args[0] === "network" && ["connect", "disconnect"].includes(args[1]!),
    ),
  ).toBe(false);
});

it("rejects remote daemons and non-loopback publication for native runners", async () => {
  state.container = false;
  state.endpoint = "ssh://remote";
  expect(() => linuxDockerDriver("native-test")).toThrow("local Docker daemon");
  vi.stubEnv("DOCKER_HOST", "unix:///var/run/docker.sock");
  vi.stubEnv("DOCKER_CONTEXT", "remote");
  expect(() => linuxDockerDriver("native-test")).toThrow("local Docker daemon");
  vi.stubEnv("DOCKER_HOST", undefined);
  vi.stubEnv("DOCKER_CONTEXT", undefined);
  expect(state.calls.some((args) => args[1] === "create")).toBe(false);
  state.endpoint = "unix:///var/run/docker.sock";
  state.publicBinding = true;

  const io = linuxDockerDriver("native-test");

  await expect(io.driver.start(spec, true)).rejects.toThrow();
  expect(Object.keys(state.resources.network!)).toHaveLength(0);
  expect(Object.keys(state.resources.volume!)).toHaveLength(0);
});

it("refreshes the native published-port target after a real proxy restart", async () => {
  state.container = false;

  const io = linuxDockerDriver("native-test");
  const resources = await io.driver.start(spec, true);
  const fixture = { ...spec, ...resources } as never;
  const server = createServer((_request, response) => response.end("new published port"));

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    await io.driver.control(fixture, "stop");
    state.nextPort = String((server.address() as { port: number }).port);
    await io.driver.control(fixture, "start");
    expect(await (await realFetch(resources.endpoint)).text()).toBe("new published port");
  } finally {
    await io.driver.stop(fixture, true);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("guards platform, run identity, process errors, and current container identity", () => {
  expect(() => requireLinux("darwin")).toThrow("Linux runner");
  expect(() => linuxDockerDriver("../bad")).toThrow();
  state.spawnError = true;
  expect(() => docker(["version"])).toThrow("spawn failed");
  state.spawnError = false;
  state.resources.container = {};
  expect(() => linuxDockerDriver("ci-test")).toThrow("Cannot identify");
});

it("controls only owned backends, including no-op transitions and readiness retries", async () => {
  vi.stubEnv("CR_CI_PARENT_RUN_ID", "parent-run");

  const io = linuxDockerDriver("ci-test");
  const resources = await io.driver.start(spec, true);
  const fixture = { ...spec, ...resources } as never;

  expect(io.inspectBackend(fixture)?.Config.Image).toBe(spec.image);
  expect(await io.driver.absent(fixture)).toBe(false);

  const info = state.resources.container![resources.containerId];

  await io.driver.control(fixture, "start");
  await io.driver.control(fixture, "unpause");
  info.State.Paused = true;
  await io.driver.control(fixture, "pause");
  await io.driver.control(fixture, "unpause");
  info.State.Paused = false;
  await io.driver.control(fixture, "pause");
  await io.driver.control(fixture, "restart");
  await io.driver.control(fixture, "stop");
  await io.driver.control(fixture, "stop");
  await io.driver.control(fixture, "start");
  vi.mocked(fetch).mockRejectedValueOnce(new Error("not ready"));
  await io.driver.ready(fixture);
  await expect(io.driver.stop(fixture, false)).rejects.toThrow("discarded");
  await io.driver.stop(fixture, true);
  await io.driver.stop(fixture, true);
});

it("copies service inputs and removes sidecars on failed startup or early exit", async () => {
  const io = linuxDockerDriver("ci-test");
  const resources = await io.driver.start(spec, true);
  const fixture = { ...spec, ...resources, credentialsFile: "/tmp/credentials.json" } as never;

  const service = await io.service(fixture, {
    name: "sidecar",
    image: spec.image,
    port: 8025,
    environment: { EXAMPLE: "value" },
    copy: [["source", "/destination"]],
  });

  expect(state.calls.some((args) => args[0] === "cp")).toBe(true);
  await service.close();
  state.exited = true;

  await expect(
    io.service(fixture, { name: "failed", image: spec.image, port: 8025 }),
  ).rejects.toThrow("Service failed failed");

  state.exited = false;
  state.failCreate = true;

  await expect(
    io.service(fixture, { name: "failed", image: spec.image, port: 8025 }),
  ).rejects.toThrow("creation failed");

  state.failCreate = false;
  await io.driver.stop(fixture, true);
});

it("still removes failed sidecars when writing diagnostics fails", async () => {
  const io = linuxDockerDriver("ci-test");
  const resources = await io.driver.start(spec, true);
  const fixture = { ...spec, ...resources, credentialsFile: "/tmp/credentials.json" } as never;

  state.exited = true;
  vi.mocked(writeFile).mockRejectedValueOnce(new Error("disk full"));

  await expect(
    io.service(fixture, { name: "sidecar", image: spec.image, port: 8025 }),
  ).rejects.toThrow("disk full");

  expect(Object.keys(state.resources.container!)).toEqual(["a".repeat(64), resources.containerId]);
  await io.driver.stop(fixture, true);
});
