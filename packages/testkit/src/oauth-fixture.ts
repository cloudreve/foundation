// Administrative fixture setup only. Product operations use the SDK/CLI afterward.
import * as v from "valibot";
import type { FixtureRequest } from "./manifest.js";
import { randomBytes, randomUUID } from "node:crypto";

export async function oauthFixture(
  request: FixtureRequest,
  options: { redirectUri?: string; scopes?: readonly string[] } = {},
) {
  const clientId = randomUUID();
  const clientSecret = randomBytes(32).toString("base64url");
  const redirectUri = options.redirectUri ?? "http://localhost/fixture-callback";

  const scopes = v.parse(
    v.pipe(
      v.array(
        v.picklist(["openid", "profile", "email", "offline_access", "UserInfo.Read", "Files.Read"]),
      ),
      v.check((values) => values.includes("openid"), "OAuth fixture requires openid"),
    ),
    options.scopes === undefined
      ? ["openid", "profile", "email", "offline_access"]
      : options.scopes,
  );

  const scope = [...new Set(scopes)].join(" ");

  const redirect = new URL(redirectUri);

  if (
    redirect.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(redirect.hostname) ||
    redirect.username ||
    redirect.password
  ) {
    throw Error("OAuth fixture requires a loopback HTTP callback");
  }

  const created = v.parse(
    v.looseObject({ id: v.pipe(v.number(), v.integer(), v.minValue(1)) }),
    await request("/api/v4/admin/oauthClient", {
      method: "PUT",
      body: JSON.stringify({
        client: {
          guid: clientId,
          secret: clientSecret,
          name: "Parity test client",
          homepage_url: "http://localhost",
          redirect_uris: [redirectUri],
          scopes: scope.split(" "),
          is_enabled: true,
        },
      }),
    }),
  );

  return {
    credentials: { clientId, clientSecret, redirectUri, scope },
    close: async () => {
      await request(`/api/v4/admin/oauthClient/${created.id}`, {
        method: "DELETE",
      });
    },
  };
}
