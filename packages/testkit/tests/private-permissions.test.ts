import { afterEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ exec: vi.fn(), end: vi.fn() }));

vi.mock("node:child_process", () => ({ execFile: mock.exec }));

import { windowsPrivacy } from "../src/private-permissions.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  mock.exec.mockReset();
  mock.end.mockReset();
});

it("does not invoke Windows tools on other platforms", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  await windowsPrivacy("/fixture");
  expect(mock.exec).not.toHaveBeenCalled();
});

it("passes paths as JSON input and requests protected directory ACLs", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.stubEnv("SystemRoot", "C:\\Windows");

  mock.exec.mockImplementation((_file, _args, _options, callback) => {
    callback(null);

    return { stdin: { end: mock.end } };
  });

  const path = "C:\\shared\\quote'$(command)";

  await windowsPrivacy(path, true, true);
  expect(mock.end).toHaveBeenCalledWith(JSON.stringify({ path, protect: true, directory: true }));
  expect(mock.exec.mock.calls[0]![1]).not.toContain(path);
  expect(mock.exec.mock.calls[0]![2]).toMatchObject({ windowsHide: true, timeout: 15_000 });
});

it("fails closed without exposing process output or credential contents", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.stubEnv("SystemRoot", undefined);

  mock.exec.mockImplementation((_file, _args, _options, callback) => {
    callback(new Error("sensitive process detail"));

    return {};
  });

  await expect(windowsPrivacy("C:\\fixture.json")).rejects.toThrow("restricted to its owner");
});
