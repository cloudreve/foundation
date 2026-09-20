// Optional services for owned, disposable Community parity acceptance only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DockerComposeEnvironment, Wait } from "testcontainers";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { validateFixture, type Fixture, type FixtureRequest } from "./manifest.js";
import * as v from "valibot";

export const serviceImages = {
  mail: "axllent/mailpit@sha256:df6c2541907e1be6fac21f509927cf6ed771617a1f4b361ef66d97bd05593d2d",
  search:
    "getmeili/meilisearch@sha256:9cde2774864e6c19cdd09fcd2950bc01ac9a0454b6f343fffafa14faae6eb7ea",
  extractor: "apache/tika@sha256:c0154cb95587cde64be74f35ada1a2bd7892219f3f0ac3c9dc6cab34046b3573",
};

const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 120_000 }).trim();

const inspectSchema = v.looseObject({
  Config: v.optional(v.looseObject({ Labels: v.nullish(v.record(v.string(), v.string()), {}) })),
  Labels: v.nullish(v.record(v.string(), v.string()), {}),
});

const inspect = (id: string) => v.parse(inspectSchema, JSON.parse(docker("inspect", id))[0]);

/** request is an authenticated SDK session request, used only for admin fixture setup. */
export async function parityServices(fixture: Fixture, request: FixtureRequest) {
  validateFixture(fixture, fixture.owner);
  assert.equal(fixture.kind, "ephemeral");
  assert.equal(fixture.role, "test");

  const labels = {
    "dev.cloudreve.worktree": fixture.owner,
    "dev.cloudreve.role": fixture.role,
    "dev.cloudreve.fixture": fixture.id,
  };

  const owned = (id: string) => {
    const info = inspect(id);

    for (const [key, value] of Object.entries(labels)) {
      assert.equal(info.Config?.Labels?.[key] ?? info.Labels?.[key], value);
    }

    return info;
  };

  owned(fixture.containerId);
  owned(fixture.network);

  const suffix = randomUUID().slice(0, 8);
  const project = `parity-services-${randomUUID()}`;

  const tlsDir = join(dirname(fixture.credentialsFile), `mail-tls-${suffix}`);

  mkdirSync(tlsDir, { mode: 0o700 });

  const alias = (kind: keyof typeof serviceImages) => `parity-${kind}-${suffix}`;

  let original: Record<string, string> | undefined;
  let stack: Awaited<ReturnType<DockerComposeEnvironment["up"]>> | undefined;

  // Community batches deduplicate different reload handlers by their shared function type.
  // Configure keys separately so SMTP, indexer and extractor each reload deterministically.
  const set = async (settings: Record<string, string>) => {
    for (const [key, value] of Object.entries(settings)) {
      await request("/api/v4/admin/settings", {
        method: "PATCH",
        body: JSON.stringify({ settings: { [key]: value } }),
      });
    }
  };

  const close = async () => {
    try {
      if (original) {
        await set(original);
        original = undefined;
      }
    } finally {
      if (stack) {
        await stack.down();
        stack = undefined;
      }

      rmSync(tlsDir, { recursive: true, force: true });
    }
  };

  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(tlsDir, "key.pem"),
        "-out",
        join(tlsDir, "cert.crt"),
        "-days",
        "2",
        "-subj",
        `/CN=${alias("mail")}`,
        "-addext",
        `subjectAltName=DNS:${alias("mail")}`,
      ],
      { stdio: "ignore" },
    );

    docker(
      "cp",
      join(tlsDir, "cert.crt"),
      `${fixture.containerId}:/usr/local/share/ca-certificates/parity-mail.crt`,
    );

    docker("exec", fixture.containerId, "update-ca-certificates");

    const service = (kind: keyof typeof serviceImages, port: number) => ({
      image: serviceImages[kind],
      labels,
      ports: [`127.0.0.1::${port}`],
      networks: { fixture: { aliases: [alias(kind)] } },
    });

    writeFileSync(
      join(tlsDir, "compose.json"),
      JSON.stringify({
        services: {
          mail: {
            ...service("mail", 8025),
            environment: {
              MP_SMTP_AUTH_ACCEPT_ANY: "1",
              MP_SMTP_TLS_CERT: "/tls/cert.crt",
              MP_SMTP_TLS_KEY: "/tls/key.pem",
            },
            volumes: [`${tlsDir}:/tls:ro`],
          },
          search: service("search", 7700),
          extractor: service("extractor", 9998),
        },
        networks: { fixture: { external: true, name: fixture.network } },
      }),
      { mode: 0o600 },
    );

    try {
      stack = await new DockerComposeEnvironment(tlsDir, "compose.json")
        .withProjectName(project)
        .withWaitStrategy("mail-1", Wait.forHttp("/livez", 8025))
        .withWaitStrategy("search-1", Wait.forHttp("/health", 7700))
        .withWaitStrategy("extractor-1", Wait.forHttp("/version", 9998))
        .withStartupTimeout(120000)
        .up();
    } catch (error) {
      // Also handle Compose failures that occur before Testcontainers reaches readiness.
      docker("compose", "-p", project, "-f", join(tlsDir, "compose.json"), "down", "--volumes");

      throw error;
    }

    const address = (kind: keyof typeof serviceImages, port: number) => ({
      alias: alias(kind),
      endpoint: `http://127.0.0.1:${stack!.getContainer(`${kind}-1`).getMappedPort(port)}`,
    });

    const mail = address("mail", 8025);
    const search = address("search", 7700);
    const extractor = address("extractor", 9998);

    const settings = {
      smtpHost: mail.alias,
      smtpUser: "fixture",
      smtpPort: "1025",
      smtpEncryption: "0",
      fromAdress: "cloudreve@fixture.test",
      fromName: "Cloudreve fixture",
      register_enabled: "1",
      email_active: "0",
      fts_enabled: "1",
      fts_index_type: "meilisearch",
      fts_extractor_type: "tika",
      fts_meilisearch_endpoint: `http://${search.alias}:7700`,
      fts_tika_endpoint: `http://${extractor.alias}:9998`,
      fts_tika_exts: "txt,md",
      fs_event_push_enabled: "1",
      fs_event_push_debounce: "1",
      use_sse_for_search: "0",
    };

    const saved = v.parse(
      v.record(v.string(), v.string()),
      await request("/api/v4/admin/settings", {
        method: "POST",
        body: JSON.stringify({ keys: Object.keys(settings) }),
      }),
    );

    original = Object.fromEntries(Object.keys(settings).map((key) => [key, saved[key] ?? ""]));

    await set(settings);

    return {
      mail: mail.endpoint,
      search: search.endpoint,
      extractor: extractor.endpoint,
      images: serviceImages,
      set,
      close,
    };
  } catch (error) {
    await close();

    throw error;
  }
}
