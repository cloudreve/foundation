import * as v from "valibot";
import { isAbsolute, dirname, resolve } from "node:path";

export const COMMUNITY_IMAGE =
  "cloudreve/cloudreve@sha256:f7a464100bf6325e9ba58cb2b0ee60f9a24c58fc2eb90647720bc4b8f3cddd9a";

const imageSchema = v.pipe(
  v.string(),
  v.regex(/^(?:[a-zA-Z0-9][a-zA-Z0-9._:/-]*@)?sha256:[a-f0-9]{64}$/),
);

export const validateImage = (value: string) => v.parse(imageSchema, value);

const name = v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9_-]{0,100}$/));

const absolute = v.pipe(v.string(), v.check(isAbsolute, "Expected an absolute path"));

export const fixtureSchema = v.looseObject({
  schemaVersion: v.literal(2),
  status: v.optional(v.picklist(["starting", "ready"]), "ready"),
  kind: v.picklist(["ephemeral", "persistent"]),
  id: name,
  owner: absolute,
  role: v.picklist(["test", "dev"]),
  project: name,
  image: imageSchema,
  endpoint: v.pipe(
    v.string(),
    v.url(),
    v.check(
      (s) => /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(s),
      "Fixture must use local HTTP",
    ),
  ),
  containerId: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  network: v.pipe(v.string(), v.minLength(1)),
  volume: v.pipe(v.string(), v.minLength(1)),
  credentialsFile: absolute,
  secondaryCredentialsFile: absolute,
  corsOrigin: v.string(),
});

export type Fixture = v.InferOutput<typeof fixtureSchema>;

export interface StartOptions {
  owner: string;
  output: string;
  id?: string;
  image?: string;
  role?: "test" | "dev";
  port?: number;
  corsOrigin?: string;
}

export function validateFixture(value: unknown, owner: string): Fixture {
  const fixture = v.parse(fixtureSchema, value);

  if (fixture.owner !== resolve(owner)) {
    throw new Error("Fixture belongs to another project");
  }

  return fixture;
}

export function validateCredentialPaths(fixture: Fixture, manifestPath: string): void {
  if (
    dirname(fixture.credentialsFile) !== dirname(resolve(manifestPath)) ||
    dirname(fixture.secondaryCredentialsFile) !== dirname(resolve(manifestPath))
  ) {
    throw new Error("Credentials outside fixture directory");
  }
}

export const runName = (value: string) => v.parse(name, value);

/** Authenticated request port for administrative setup on an owned test fixture. */
export type FixtureRequest = (
  path: string,
  options?: { method?: string; body?: string },
) => Promise<unknown>;
