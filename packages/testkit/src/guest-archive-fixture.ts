import * as v from "valibot";
import type { FixtureRequest } from "./manifest.js";

/** Enable archive download only for the owned fixture's anonymous group; restore afterward. */
export async function guestArchiveFixture(request: FixtureRequest) {
  const group = v.parse(
    v.looseObject({ id: v.literal(3), permissions: v.string() }),
    await request("/api/v4/admin/group/3"),
  );

  const permissions = Buffer.from(group.permissions, "base64");

  if (permissions.toString("base64") !== group.permissions || !(permissions[0]! & 2)) {
    throw new Error("Expected owned anonymous group identity");
  }

  permissions[0]! |= 16; // Community GroupPermissionArchiveDownload (bit 4).

  await request("/api/v4/admin/group/3", {
    method: "PUT",
    body: JSON.stringify({
      group: { ...group, permissions: permissions.toString("base64") },
    }),
  });

  return () =>
    request("/api/v4/admin/group/3", {
      method: "PUT",
      body: JSON.stringify({ group }),
    });
}
