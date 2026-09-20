import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { createServer, connect, type Socket, type Server, type AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { Fixture } from "./manifest.js";
import type { Driver, Spec } from "./driver.js";

interface DockerInfo {
  Id: string;
  Image: string;
  Config: { Image: string; Labels?: Record<string, string> };
  Labels?: Record<string, string>;
  State: {
    Running: boolean;
    Paused: boolean;
    ExitCode: number;
    OOMKilled: boolean;
    Error?: string;
  };
  NetworkSettings: {
    Ports: Record<string, { HostIp: string; HostPort: string }[]>;
    Networks: Record<string, { IPAddress: string }>;
  };
  Containers?: Record<string, unknown>;
  IPAM: { Config: { Gateway: string }[] };
  Os: string;
  Architecture: string;
}

interface ServiceOptions {
  name: string;
  image: string;
  port: number;
  platform?: "linux/amd64" | "linux/arm64";
  environment?: Record<string, string>;
  copy?: string[][];
  health?: string;
}

type Owner = Pick<Spec, "owner" | "id">;

type Bridge = Awaited<ReturnType<typeof loopbackBridge>>;

type Service = { close(): Promise<void> };

/** Reject unsupported E2E runners before creating Docker resources. */
export function requireLinux(platform = process.platform): void {
  if (platform !== "linux") {
    throw new Error("Community Docker E2E requires a Linux runner.");
  }
}

const ownerKey = "dev.cloudreve.worktree";

/** Execute Docker with bounded runtime; optionally tolerate absent resources. */
export function docker(args: string[], options?: { missing?: false }): string;

export function docker(args: string[], options: { missing: boolean }): string | null;

export function docker(args: string[], { missing = false } = {}): string | null {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: 120_000,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    if (missing && /No such|not found/i.test(result.stderr)) {
      return null;
    }

    throw new Error(`Docker ${args[0]} ${args[1] ?? ""} failed: ${result.stderr.trim()}`);
  }

  return (result.stdout + (args[0] === "logs" ? result.stderr : "")).trim();
}

function inspect(kind: string, id: string): DockerInfo | null {
  const output = docker([kind, "inspect", id], { missing: true });

  return output === null ? null : JSON.parse(output)[0];
}

/** Verify the fixture labels before controlling or deleting a resource. */
export function assertOwned(info: unknown, fixture: Owner): void {
  const resource = info as Pick<DockerInfo, "Config" | "Labels"> | null;
  const labels = resource?.Config?.Labels ?? resource?.Labels;

  assert.equal(labels?.[ownerKey], fixture.owner, "Foreign fixture owner");
  assert.equal(labels?.["dev.cloudreve.fixture"], fixture.id, "Foreign fixture identity");
  assert.equal(labels?.["dev.cloudreve.role"], "test", "Not a test fixture");
}

const labelArgs = (spec: Pick<Spec, "owner" | "id" | "role">, runId: string) =>
  Object.entries({
    [ownerKey]: spec.owner,
    "dev.cloudreve.fixture": spec.id,
    "dev.cloudreve.role": spec.role,
    "dev.cloudreve.ci-run": runId,
    "dev.cloudreve.ci-parent": process.env.CR_CI_PARENT_RUN_ID ?? runId,
  }).flatMap(([key, value]) => ["--label", `${key}=${value}`]);

/** Bound and redact diagnostics before exposing service failures in CI output. */
export function serviceFailureDetails(
  name: string,
  state: Pick<DockerInfo["State"], "Error" | "ExitCode" | "OOMKilled">,
  startup: string,
): string {
  const detail = [state.Error ?? "", startup]
    .join("\n")
    .split("\n")
    .map((line) =>
      /password|secret|token|authorization|master.?key|api.?key/i.test(line)
        ? "[redacted key-bearing service log line]"
        : line.replace(/https?:\/\/[^\s<>"']+/g, "[URL]"),
    )
    .join("\n")
    .slice(-4000);

  return `Service ${name} failed: exit=${state.ExitCode}, oom=${state.OOMKilled}\n${detail}`;
}

/** Forward a local endpoint to an isolated fixture, retaining it across restarts. */
export async function loopbackBridge(host: string, port: number, bindAddresses = ["0.0.0.0"]) {
  const sockets = new Set<Socket>();

  const handle = (client: Socket) => {
    const upstream = connect({ host, port });

    upstream.setTimeout(5000, () => {
      client.destroy();
      upstream.destroy();
    });

    upstream.once("connect", () => upstream.setTimeout(0));

    for (const socket of [client, upstream]) {
      sockets.add(socket);

      socket.on("error", () => {
        client.destroy();
        upstream.destroy();
      });

      socket.on("close", () => {
        sockets.delete(socket);
        client.destroy();
        upstream.destroy();
      });
    }

    client.pipe(upstream).pipe(client);
  };

  const servers: Server[] = [];
  let listenPort = 0;

  try {
    for (const address of new Set(bindAddresses)) {
      const server = createServer(handle);

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(listenPort, address, resolve);
      });

      servers.push(server);
      listenPort = (server.address() as AddressInfo).port;
    }

    assert(servers.length, "A fixture bridge requires a bind address");
  } catch (error) {
    for (const server of servers) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    throw error;
  }

  const disconnect = () => {
    for (const socket of sockets) {
      socket.destroy();
    }
  };

  return {
    endpoint: `http://localhost:${listenPort}`,
    disconnect,
    setTarget(nextHost: string, nextPort: number) {
      disconnect();
      host = nextHost;
      port = nextPort;
    },
    close: async () => {
      disconnect();

      for (const server of servers) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  };
}

async function ready(
  endpoint: string,
  path = "/api/v4/site/config/login",
  running?: () => boolean | undefined,
) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (running) {
      assert(running(), "Fixture process exited during readiness");
    }

    try {
      const response = await fetch(endpoint + path, {
        signal: AbortSignal.timeout(1000),
        redirect: "error",
      });

      await response.arrayBuffer();

      if (response.ok) {
        return;
      }
    } catch {
      /* The owned service is still starting. */
    }

    await delay(500);
  }

  throw new Error("Owned fixture did not become ready");
}

function publishedAddress(info: DockerInfo, port: number) {
  const bindings = info.NetworkSettings.Ports[`${port}/tcp`];

  assert.equal(bindings?.length, 1, "Expected one loopback-only published fixture port");
  assert.equal(bindings[0]!.HostIp, "127.0.0.1");

  const published = Number(bindings[0]!.HostPort);

  assert(Number.isInteger(published) && published > 0 && published <= 65535);

  return { host: "127.0.0.1", port: published };
}

/** CI transport adapter for Testkit: runner paths never become daemon bind mounts. */
export function linuxDockerDriver(runId: string) {
  requireLinux();
  assert.match(runId, /^[a-z0-9][a-z0-9_-]{0,100}$/);

  const container = existsSync("/.dockerenv") || existsSync("/run/.containerenv");
  const runner = container ? inspect("container", hostname()) : null;

  if (container) {
    assert(
      runner?.Id.startsWith(hostname()) && runner.State.Running,
      "Cannot identify current Linux job container",
    );
  } else {
    const endpoint = process.env.DOCKER_CONTEXT
      ? docker([
          "context",
          "inspect",
          process.env.DOCKER_CONTEXT,
          "--format",
          "{{.Endpoints.docker.Host}}",
        ])
      : process.env.DOCKER_HOST ||
        docker(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);

    assert(endpoint.startsWith("unix://"), "Native Linux E2E requires a local Docker daemon");
  }

  const owned = (info: DockerInfo | null, fixture: Owner): void => {
    assert(info, "Fixture resource is absent");
    assertOwned(info, fixture);

    assert.equal(
      (info.Config?.Labels ?? info.Labels)!["dev.cloudreve.ci-run"],
      runId,
      "Foreign CI run",
    );
  };

  const state = new Map<
    string,
    { bridge: Bridge; runnerAddress: string; network: string; services: Service[] }
  >();

  const driver: Driver = {
    async start(spec, ephemeral) {
      assert(ephemeral && spec.role === "test", "CI only creates disposable test fixtures");

      const labels = labelArgs(spec, runId);

      const network = `${spec.project}-network`;
      const volume = `${spec.project}-data`;

      let containerId: string | undefined;
      let bridge: Bridge | undefined;
      const resources = { ...spec, network, volume };

      try {
        docker(["network", "create", ...labels, network]);

        if (runner) {
          docker(["network", "connect", network, runner.Id]);
        }

        docker(["volume", "create", ...labels, volume]);
        owned(inspect("volume", volume), resources);

        containerId = docker([
          "create",
          "--platform",
          "linux/amd64",
          "--name",
          `${spec.project}-backend`,
          ...labels,
          "--network",
          network,
          ...(runner ? [] : ["--publish", "127.0.0.1::5212"]),
          "--mount",
          `type=volume,source=${volume},target=/cloudreve/data`,
          "--env",
          `CR_SETTING_DEFAULT_siteName=${spec.id}`,
          "--env",
          `CR_CONF_CORS.AllowOrigins=${spec.corsOrigin}`,
          spec.image!,
        ]);

        docker(["start", containerId]);

        const info = inspect("container", containerId)!;

        owned(info, resources);

        assert.equal(
          info.Config.Image,
          spec.image!,
          "Backend image differs from the pinned request",
        );

        const address = runner
          ? {
              host: info.NetworkSettings.Networks[network]!.IPAddress,
              port: 5212,
            }
          : publishedAddress(info, 5212);

        const runnerAddress = runner
          ? inspect("container", runner.Id)!.NetworkSettings.Networks[network]!.IPAddress
          : inspect("network", network)!.IPAM.Config[0]!.Gateway;

        assert(runnerAddress, "Owned fixture network has no worker-reachable host route");

        bridge = await loopbackBridge(
          address.host,
          address.port,
          runner ? undefined : ["127.0.0.1", runnerAddress],
        );

        state.set(containerId, {
          bridge,
          runnerAddress,
          network,
          services: [],
        });

        await ready(bridge.endpoint);

        return { containerId, network, volume, endpoint: bridge.endpoint };
      } catch (error) {
        const errors: unknown[] = [error];

        const attempt = async (action: () => unknown) => {
          try {
            await action();
          } catch (cleanupError) {
            errors.push(cleanupError);
          }
        };

        await attempt(() => bridge?.close());

        await attempt(() => {
          if (containerId) {
            const info = inspect("container", containerId)!;

            if (info) {
              owned(info, resources);
              docker(["rm", "-f", "-v", containerId]);
            }
          }
        });

        await attempt(() => {
          const net = inspect("network", network);

          if (net) {
            owned(net, resources);

            if (runner && net.Containers?.[runner.Id]) {
              docker(["network", "disconnect", "-f", network, runner.Id]);
            }

            docker(["network", "rm", network]);
          }
        });

        await attempt(() => {
          const vol = inspect("volume", volume);

          if (vol) {
            owned(vol, resources);
            docker(["volume", "rm", volume]);
          }
        });

        if (containerId) {
          state.delete(containerId);
        }

        if (errors.length > 1) {
          throw new AggregateError(errors, String(error) + "; owned cleanup also failed");
        }

        throw error;
      }
    },
    async ready(fixture) {
      await ready(fixture.endpoint);
    },
    async control(fixture, action) {
      const info = inspect("container", fixture.containerId)!;

      owned(info, fixture);
      assert.equal(info.Config.Image, fixture.image);
      assert(["pause", "unpause", "restart", "start", "stop"].includes(action));

      if (action === "pause" && info.State.Paused) {
        return;
      }

      if (action === "unpause" && !info.State.Paused) {
        return;
      }

      if (action === "start" && info.State.Running) {
        return;
      }

      if (action === "stop" && !info.State.Running) {
        state.get(fixture.containerId)?.bridge.disconnect();

        return;
      }

      docker([action, fixture.containerId]);

      // Explicit fault injection: Docker network teardown need not deliver TCP FIN.
      if (action === "stop") {
        state.get(fixture.containerId)?.bridge.disconnect();
      }

      if (["start", "restart"].includes(action)) {
        const started = inspect("container", fixture.containerId)!;

        owned(started, fixture);
        assert.equal(started.Config.Image, fixture.image);

        const address = runner
          ? {
              host: started.NetworkSettings.Networks[fixture.network]!.IPAddress,
              port: 5212,
            }
          : publishedAddress(started, 5212);

        state.get(fixture.containerId)!.bridge.setTarget(address.host, address.port);
      }

      if (["start", "restart", "unpause"].includes(action)) {
        await ready(fixture.endpoint);
      }
    },
    async stop(fixture, remove) {
      assert(remove, "CI fixtures must be discarded");

      const resources: [string, string][] = [
        ["container", fixture.containerId],
        ["network", fixture.network],
        ["volume", fixture.volume],
      ];

      for (const [kind, id] of resources) {
        const info = inspect(kind, id);

        if (info) {
          owned(info, fixture);
        }
      }

      const errors: unknown[] = [];

      const attempt = async (action: () => unknown) => {
        try {
          await action();
        } catch (error) {
          errors.push(error);
        }
      };

      const current = state.get(fixture.containerId);

      for (const service of [...(current?.services ?? [])].reverse()) {
        await attempt(() => service.close());
      }

      await attempt(() => {
        const info = inspect("container", fixture.containerId)!;

        if (info) {
          owned(info, fixture);
          docker(["rm", "-f", "-v", fixture.containerId]);
        }
      });

      await attempt(() => current?.bridge.close());

      await attempt(() => {
        const network = inspect("network", fixture.network);

        if (network) {
          owned(network, fixture);

          if (runner && network.Containers?.[runner.Id]) {
            docker(["network", "disconnect", "-f", fixture.network, runner.Id]);
          }

          docker(["network", "rm", fixture.network]);
        }
      });

      await attempt(() => {
        const volume = inspect("volume", fixture.volume);

        if (volume) {
          owned(volume, fixture);
          docker(["volume", "rm", fixture.volume]);
        }
      });

      if (errors.length) {
        throw new AggregateError(errors, "Owned fixture cleanup failed");
      }

      state.delete(fixture.containerId);
    },
    async absent(fixture) {
      return (
        !inspect("container", fixture.containerId) &&
        !inspect("network", fixture.network) &&
        !inspect("volume", fixture.volume)
      );
    },
  };

  return {
    runnerMode: runner ? "container" : "native",
    driver,
    runnerAddress: (fixture: Fixture) => state.get(fixture.containerId)!.runnerAddress,
    inspectBackend: (fixture: Fixture) => inspect("container", fixture.containerId),
    async service(
      fixture: Fixture,
      {
        name,
        image,
        port,
        platform = "linux/amd64",
        environment = {},
        copy = [],
        health = "/",
      }: ServiceOptions,
    ) {
      const labels = labelArgs(fixture, runId);
      let id: string | undefined;
      let bridge: Bridge | undefined;

      try {
        id = docker([
          "create",
          "--platform",
          platform,
          "--name",
          `${fixture.project}-${name}`,
          ...labels,
          "--network",
          fixture.network,
          ...(runner ? [] : ["--publish", `127.0.0.1::${port}`]),
          ...Object.entries(environment).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
          image,
        ]);

        for (const [source, destination] of copy) {
          docker(["cp", source!, `${id}:${destination}`]);
        }

        docker(["start", id]);

        const info = inspect("container", id!)!;

        owned(info, fixture);
        assert.equal(info.Config.Image, image);

        const imageInfo = inspect("image", info.Image)!;

        assert.equal(`${imageInfo.Os}/${imageInfo.Architecture}`, platform);

        const address = runner
          ? {
              host: info.NetworkSettings.Networks[fixture.network]!.IPAddress,
              port,
            }
          : publishedAddress(info, port);

        bridge = await loopbackBridge(
          address.host,
          address.port,
          runner ? undefined : ["127.0.0.1"],
        );

        await ready(bridge.endpoint, health, () => inspect("container", id!)?.State.Running);

        const service = {
          id,
          image: info.Config.Image,
          imageId: info.Image,
          revision: imageInfo.Config?.Labels?.["org.opencontainers.image.revision"],
          platform: `${imageInfo.Os}/${imageInfo.Architecture}`,
          alias: `${fixture.project}-${name}`,
          endpoint: bridge.endpoint,
          close: async () => {
            try {
              const info = inspect("container", id!)!;

              if (info) {
                owned(info, fixture);
                docker(["rm", "-f", "-v", id!]);
              }
            } finally {
              await bridge!.close();
            }
          },
        };

        state.get(fixture.containerId)!.services.push(service);

        return service;
      } catch (error) {
        await bridge?.close();

        if (id) {
          const info = inspect("container", id!)!;

          owned(info, fixture);

          try {
            await writeFile(
              join(dirname(fixture.credentialsFile), `${name}-failure-state.json`),
              JSON.stringify(info.State),
              { mode: 0o600 },
            );

            const startup = docker(["logs", "--tail", "80", id]);

            await writeFile(
              join(dirname(fixture.credentialsFile), `${name}-failure.log`),
              startup,
              {
                mode: 0o600,
              },
            );

            throw new Error(serviceFailureDetails(name, info.State, startup), {
              cause: error,
            });
          } finally {
            // Failure diagnostics must never prevent removal of an owned sidecar.
            docker(["rm", "-f", "-v", id]);
          }
        }

        throw error;
      }
    },
  };
}
