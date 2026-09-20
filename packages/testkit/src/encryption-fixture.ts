// Exercise non-block-aligned chunk encryption without touching persistent policies.
import * as v from "valibot";
import type { FixtureRequest } from "./manifest.js";

export async function encryptionFixture(request: FixtureRequest) {
  const original = v.parse(
    v.looseObject({
      settings: v.optional(v.record(v.string(), v.unknown()), {}),
    }),
    await request("/api/v4/admin/policy/1"),
  );

  await request("/api/v4/admin/policy/1", {
    method: "PUT",
    body: JSON.stringify({
      policy: {
        ...original,
        settings: {
          ...original.settings,
          encryption: true,
          chunk_size: 524291,
        },
      },
    }),
  });

  return async () => {
    await request("/api/v4/admin/policy/1", {
      method: "PUT",
      body: JSON.stringify({ policy: original }),
    });
  };
}
