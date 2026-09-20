import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedAccounts } from "../src/seed.js";
import { COMMUNITY_IMAGE, type Fixture } from "../src/manifest.js";

let dir: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "testkit-seed-")));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fixture(): Fixture {
  return {
    schemaVersion: 2,
    status: "ready",
    kind: "ephemeral",
    id: "seed",
    owner: dir,
    role: "test",
    project: "seed-project",
    image: COMMUNITY_IMAGE,
    endpoint: "http://127.0.0.1:25000",
    containerId: "a".repeat(64),
    network: "opaque-network",
    volume: "opaque-volume",
    credentialsFile: join(dir, "credentials.json"),
    secondaryCredentialsFile: join(dir, "second.json"),
    corsOrigin: "http://localhost",
  };
}

function network() {
  const accounts = new Set<string>();

  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).split("/api/v4/")[1];
    const body = JSON.parse(String(init?.body));

    if (path === "user") {
      accounts.add(body.email);

      return Response.json({ code: 0 });
    }

    if (path === "admin/settings") {
      return Response.json({ code: 0 });
    }

    return Response.json(
      accounts.has(body.email)
        ? { code: 0, data: { token: { access_token: "fixture-token" } } }
        : { code: 401 },
    );
  });

  return { fetch, accounts };
}

it("creates private credentials, registers both identities and reuses them without registration", async () => {
  const f = fixture();
  const n = network();

  await seedAccounts(f, n.fetch as typeof fetch);

  expect(n.accounts).toEqual(new Set(["admin@cloudreve.test", "second@cloudreve.test"]));

  const saved = JSON.parse(await readFile(f.credentialsFile, "utf8"));

  expect(saved.email).toBe("admin@cloudreve.test");
  expect(saved.password).toHaveLength(32);
  expect((await stat(f.credentialsFile)).mode & 0o777).toBe(0o600);

  const settings = n.fetch.mock.calls.find(([url]) => String(url).endsWith("/admin/settings"))!;

  expect(settings[1]?.method).toBe("PATCH");

  expect(JSON.parse(String(settings[1]?.body))).toEqual({
    settings: { siteURL: f.endpoint },
  });

  expect(new Headers(settings[1]?.headers).get("Authorization")).toBe("Bearer fixture-token");

  expect(settings[1]?.redirect).toBe("error");
  expect(settings[1]?.signal).toBeInstanceOf(AbortSignal);
  n.fetch.mockClear();
  await seedAccounts(f, n.fetch as typeof fetch);

  expect(n.fetch.mock.calls.some(([url]) => String(url).endsWith("/user"))).toBe(false);

  expect(JSON.parse(await readFile(f.credentialsFile, "utf8"))).toEqual(saved);
});

it.each(["http", "registration", "login", "settings", "token", "envelope", "json", "network"])(
  "propagates %s bootstrap failure without claiming successful seeding",
  async (mode) => {
    const f = fixture();
    const n = network();
    const original = n.fetch.getMockImplementation()!;

    n.fetch.mockImplementation(async (url, init) => {
      const path = String(url).split("/api/v4/")[1];

      if (mode === "network") {
        throw Error("offline");
      }

      if (mode === "http") {
        return new Response("", { status: 503 });
      }

      if (mode === "json") {
        return new Response("not JSON");
      }

      if (mode === "envelope") {
        return Response.json({ code: "0" });
      }

      if (mode === "registration" && path === "user") {
        return Response.json({ code: 9 });
      }

      if (mode === "login" && path === "session/token") {
        return Response.json({ code: 401 });
      }

      if (mode === "settings" && path === "admin/settings") {
        return Response.json({ code: 9 });
      }

      if (mode === "token" && path === "session/token") {
        return Response.json({
          code: 0,
          data: { token: { access_token: "" } },
        });
      }

      return original(url, init);
    });

    await expect(seedAccounts(f, n.fetch as typeof fetch)).rejects.toThrow();

    expect(
      n.fetch.mock.calls.some(
        ([, init]) => JSON.parse(String(init?.body)).email === "second@cloudreve.test",
      ),
    ).toBe(false);
  },
);

it.each([
  { email: "other@cloudreve.test", password: "valid-password" },
  { email: "admin@cloudreve.test", password: "short" },
  null,
])("preserves invalid existing credential records without sending requests: %j", async (value) => {
  const f = fixture();
  const n = network();

  await writeFile(f.credentialsFile, JSON.stringify(value), { mode: 0o600 });
  await expect(seedAccounts(f, n.fetch as typeof fetch)).rejects.toThrow();
  expect(n.fetch).not.toHaveBeenCalled();

  expect(JSON.parse(await readFile(f.credentialsFile, "utf8"))).toEqual(value);
});
