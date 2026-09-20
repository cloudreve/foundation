import { expect, it, vi } from "vitest";
import { guestArchiveFixture } from "../src/guest-archive-fixture.js";

it("changes only archive permission and restores the original anonymous group", async () => {
  const group = {
    id: 3,
    permissions: Buffer.from([0x82, 0x64]).toString("base64"),
    name: "Anonymous",
    settings: { max_walked_files: 100000 },
  };

  const request = vi.fn().mockResolvedValue(group);
  const restore = await guestArchiveFixture(request);

  expect(JSON.parse(request.mock.calls[1]![1].body)).toEqual({
    group: {
      ...group,
      permissions: Buffer.from([0x92, 0x64]).toString("base64"),
    },
  });

  await restore();
  expect(JSON.parse(request.mock.calls[2]![1].body)).toEqual({ group });
});

it.each([
  { id: 1, permissions: "gg==" },
  { id: 3, permissions: "AQ==" },
  { id: 3, permissions: "???" },
  { id: 3, permissions: "" },
])("rejects an invalid fixture group before mutation: %j", async (group) => {
  const request = vi.fn().mockResolvedValue(group);

  await expect(guestArchiveFixture(request)).rejects.toThrow();
  expect(request).toHaveBeenCalledOnce();
});
