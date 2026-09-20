import { randomBytes } from "node:crypto";
import * as v from "valibot";
import { readPrivate, writePrivate } from "./storage.js";
import type { Fixture } from "./manifest.js";

const envelope = v.looseObject({
  code: v.number(),
  data: v.optional(v.unknown()),
});

const credentialsSchema = v.object({
  email: v.string(),
  password: v.pipe(v.string(), v.minLength(8)),
});

const loginSchema = v.object({
  token: v.object({ access_token: v.pipe(v.string(), v.minLength(1)) }),
});

/** Only first-account/admin bootstrap lives here; normal operations use the injected SDK in scenarios. */
export async function seedAccounts(
  fixture: Fixture,
  transport: typeof fetch = fetch,
): Promise<void> {
  const call = async (path: string, body: unknown, token?: string, method = "POST") => {
    const response = await transport(`${fixture.endpoint}/api/v4/${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Fixture bootstrap HTTP ${response.status}`);
    }

    return v.parse(envelope, await response.json());
  };

  for (const [path, email] of [
    [fixture.credentialsFile, "admin@cloudreve.test"],
    [fixture.secondaryCredentialsFile, "second@cloudreve.test"],
  ] as const) {
    let credentials;

    try {
      credentials = v.parse(credentialsSchema, await readPrivate(path));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        throw e;
      }

      credentials = { email, password: randomBytes(24).toString("base64url") };
      await writePrivate(path, credentials);
    }

    if (credentials.email !== email) {
      throw new Error("Unexpected fixture identity");
    }

    let login = await call("session/token", credentials);

    if (login.code !== 0) {
      if ((await call("user", credentials)).code !== 0) {
        throw new Error("Fixture registration failed");
      }

      login = await call("session/token", credentials);
    }

    if (login.code !== 0) {
      throw new Error("Fixture login failed");
    }

    const token = v.parse(loginSchema, login.data).token.access_token;

    if (
      email === "admin@cloudreve.test" &&
      (await call("admin/settings", { settings: { siteURL: fixture.endpoint } }, token, "PATCH"))
        .code !== 0
    ) {
      throw new Error("Fixture configuration failed");
    }
  }
}
