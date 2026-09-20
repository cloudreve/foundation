import { expect, it, vi } from "vitest";
import { oauthFixture } from "../src/oauth-fixture.js";

it("preserves default scopes and closes the created application", async () => {
  const request = vi.fn().mockResolvedValue({ id: 19 });
  const fixture = await oauthFixture(request);

  expect(fixture.credentials.scope).toBe("openid profile email offline_access");

  expect(JSON.parse(request.mock.calls[0]![1].body).client.scopes).toEqual([
    "openid",
    "profile",
    "email",
    "offline_access",
  ]);

  await fixture.close();

  expect(request).toHaveBeenLastCalledWith("/api/v4/admin/oauthClient/19", {
    method: "DELETE",
  });
});

it("registers explicit browser scopes and preserves their order without duplicates", async () => {
  const request = vi.fn().mockResolvedValue({ id: 2 });
  const redirectUri = "http://127.0.0.1:34567/callback";

  const fixture = await oauthFixture(request, {
    redirectUri,
    scopes: ["openid", "UserInfo.Read", "Files.Read", "openid"],
  });

  expect(fixture.credentials.scope).toBe("openid UserInfo.Read Files.Read");

  expect(JSON.parse(request.mock.calls[0]![1].body).client).toMatchObject({
    redirect_uris: [redirectUri],
    scopes: ["openid", "UserInfo.Read", "Files.Read"],
  });
});

it.each([[], ["Files.Read"], ["openid", "admin"], "openid", null])(
  "rejects malformed or unsupported explicit scope sets before mutation: %j",
  async (scopes) => {
    const request = vi.fn();

    await expect(oauthFixture(request, { scopes: scopes as string[] })).rejects.toThrow();

    expect(request).not.toHaveBeenCalled();
  },
);
