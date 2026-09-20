import getPort from "get-port";
import {
  DockerComposeEnvironment,
  Wait,
  getContainerRuntimeClient,
  BoundPorts,
  waitForContainer,
} from "testcontainers";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContainerInspectInfo } from "dockerode";
import { COMMUNITY_IMAGE, type Fixture } from "./manifest.js";

export const composeFile = fileURLToPath(new URL("../dist/compose.yml", import.meta.url));

export interface Spec {
  owner: string;
  image?: string;
  id: string;
  role: "dev" | "test";
  project: string;
  port: number;
  corsOrigin: string;
}

export interface Resource {
  containerId: string;
  endpoint: string;
  network: string;
  volume: string;
}

export interface Driver {
  start(spec: Spec, ephemeral: boolean): Promise<Resource>;
  stop(fixture: Fixture, remove: boolean): Promise<void>;
  ready(fixture: Fixture): Promise<void>;
  absent(fixture: Fixture): Promise<boolean>;
  control(
    fixture: Fixture,
    action: "pause" | "unpause" | "restart" | "start" | "stop",
  ): Promise<void>;
}

const environment = (s: Spec) => ({
  CR_IMAGE: s.image ?? COMMUNITY_IMAGE,
  CR_OWNER: s.owner,
  CR_RUN_ID: s.id,
  CR_ROLE: s.role,
  CR_BACKEND_PORT: String(s.port),
  CR_CORS_ORIGIN: s.corsOrigin,
});

const options = (s: Spec) => ({
  filePath: dirname(composeFile),
  files: "compose.yml",
  projectName: s.project,
  environment: environment(s),
});

const owned = (
  labels: Record<string, string> | undefined,
  s: Pick<Spec, "owner" | "id" | "role">,
) => {
  labels ??= {};

  if (
    labels["dev.cloudreve.worktree"] !== s.owner ||
    labels["dev.cloudreve.fixture"] !== s.id ||
    labels["dev.cloudreve.role"] !== s.role
  ) {
    throw new Error("Resource belongs to another fixture");
  }
};

const resource = (info: ContainerInspectInfo): Resource => {
  const bindings = info.NetworkSettings.Ports["5212/tcp"];
  const binding = bindings?.find((b) => b.HostIp === "127.0.0.1");
  const networks = Object.values(info.NetworkSettings.Networks);

  const volume = info.Mounts.find(
    (m) => m.Destination === "/cloudreve/data" && m.Type === "volume",
  )?.Name;

  if (!binding || networks.length !== 1 || !volume) {
    throw new Error("Unexpected fixture resources");
  }

  return {
    containerId: info.Id,
    endpoint: `http://127.0.0.1:${binding.HostPort}`,
    network: networks[0]!.NetworkID,
    volume,
  };
};

async function verifyProject(spec: Spec): Promise<void> {
  const client = await getContainerRuntimeClient();
  const filters = { label: [`com.docker.compose.project=${spec.project}`] };

  for (const c of await client.container.dockerode.listContainers({
    all: true,
    filters,
  })) {
    owned(c.Labels, spec);

    const info = await client.container.inspect(client.container.getById(c.Id));

    if (info.Config.Image !== (spec.image ?? COMMUNITY_IMAGE)) {
      throw new Error("Fixture image differs from pinned image");
    }
  }

  for (const n of await client.container.dockerode.listNetworks({ filters })) {
    owned(n.Labels, spec);
  }

  for (const v of (await client.container.dockerode.listVolumes({ filters })).Volumes ?? []) {
    owned(v.Labels, spec);
  }
}

const wait = () =>
  Wait.forHttp("/api/v4/site/ping", 5212)
    .forStatusCode(200)
    .forResponsePredicate((body) => {
      try {
        return JSON.parse(body).code === 0;
      } catch {
        return false;
      }
    })
    .withReadTimeout(2_000)
    .withStartupTimeout(120_000);

export const dockerDriver: Driver = {
  async start(spec, ephemeral) {
    // Explicit binding survives Docker stop/start; an engine bind conflict still fails closed.
    if (spec.port === 0) {
      spec = { ...spec, port: await getPort({ host: "127.0.0.1" }) };
    }

    await verifyProject(spec);

    const client = await getContainerRuntimeClient();

    if (ephemeral) {
      try {
        const stack = await new DockerComposeEnvironment(dirname(composeFile), "compose.yml")
          .withProjectName(spec.project)
          .withEnvironment(environment(spec))
          .withWaitStrategy("cloudreve-1", wait())
          .withStartupTimeout(120_000)
          .up();

        return resource(
          await client.container.inspect(
            client.container.getById(stack.getContainer("cloudreve-1").getId()),
          ),
        );
      } catch (error) {
        await verifyProject(spec);

        await client.compose.down(options(spec), {
          timeout: 10_000,
          removeVolumes: true,
        });

        throw error;
      }
    }

    // Persistent starts deliberately bypass Testcontainers' failure teardown, which removes volumes.
    await client.compose.up({ ...options(spec), commandOptions: ["--no-recreate"] }, ["cloudreve"]);

    const container = await client.container.fetchByLabel(
      "com.docker.compose.project",
      spec.project,
      { status: ["running"] },
    );

    if (!container) {
      throw new Error("Persistent service did not start");
    }

    return resource(await client.container.inspect(container));
  },
  async ready(fixture) {
    const client = await getContainerRuntimeClient();
    const container = client.container.getById(fixture.containerId);
    const ports = new BoundPorts();

    ports.setBinding(5212, Number(new URL(fixture.endpoint).port));
    await waitForContainer(client, container, wait(), ports);
  },
  async absent(fixture) {
    const client = await getContainerRuntimeClient();

    const filters = {
      label: [`com.docker.compose.project=${fixture.project}`],
    };

    return (
      (await client.container.dockerode.listContainers({ all: true, filters })).length === 0 &&
      (await client.container.dockerode.listNetworks({ filters })).length === 0 &&
      ((await client.container.dockerode.listVolumes({ filters })).Volumes ?? []).length === 0
    );
  },
  async stop(fixture, remove) {
    const spec = { ...fixture, port: Number(new URL(fixture.endpoint).port) };

    await verifyProject(spec);

    const client = await getContainerRuntimeClient();

    if (remove) {
      await client.compose.down(options(spec), {
        timeout: 10_000,
        removeVolumes: true,
      });
    } else {
      await client.compose.stop(options(spec));
    }
  },
  async control(fixture, action) {
    const client = await getContainerRuntimeClient();
    const container = client.container.getById(fixture.containerId);
    const info = await client.container.inspect(container);

    owned(info.Config.Labels, fixture);

    if (info.Config.Image !== fixture.image) {
      throw new Error("Fixture image differs from pinned image");
    }

    if (action === "pause") {
      if (!info.State.Paused) {
        await container.pause();
      }
    } else if (action === "unpause") {
      if (info.State.Paused) {
        await container.unpause();
      }
    } else if (action === "start") {
      if (!info.State.Running) {
        await container.start();
      }
    } else if (action === "stop") {
      if (info.State.Running) {
        await container.stop({ t: 10 });
      }
    } else {
      await client.container.restart(container, { timeout: 10 });
    }
  },
};
