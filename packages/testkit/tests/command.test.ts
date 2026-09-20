import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { main, parse } from "../src/command.js";
import type { CommunityIO } from "../src/community.js";

let owner: string;

beforeEach(async () => {
  owner = await realpath(await mkdtemp(join(tmpdir(), "testkit-command-")));
});

afterEach(async () => {
  await rm(owner, { recursive: true, force: true });
});

function harness() {
  const host = Object.assign(new EventEmitter(), {
    cwd: () => owner,
    stdin: new PassThrough(),
    stdout: { write: vi.fn() },
    stderr: { write: vi.fn() },
  });

  const driver = {
    start: vi.fn(async () => ({
      containerId: "a".repeat(64),
      endpoint: "http://127.0.0.1:25000",
      network: "network-id",
      volume: "volume-id",
    })),
    stop: vi.fn(async () => {}),
    ready: vi.fn(async () => {}),
    control: vi.fn(async () => {}),
    absent: vi.fn(async () => true),
  };

  return {
    host,
    process: host as unknown as NodeJS.Process,
    driver,
    io: { driver, seed: vi.fn(async () => {}) } as CommunityIO,
  };
}

it("parses explicit maintenance options and rejects ambiguous input", () => {
  expect(
    parse(
      [
        "start",
        "--output",
        join(owner, "fixture.json"),
        "--owner",
        owner,
        "--id",
        "devbox",
        "--role",
        "test",
        "--port",
        "1234",
        "--cors-origin",
        "http://localhost:8000",
      ],
      owner,
    ),
  ).toEqual({
    action: "start",
    options: {
      output: join(owner, "fixture.json"),
      owner,
      id: "devbox",
      role: "test",
      port: 1234,
      corsOrigin: "http://localhost:8000",
    },
  });

  for (const args of [
    [],
    ["unknown"],
    ["start"],
    ["start", "stop", "--output", "x"],
    ["start", "--output", "x", "--role", "wrong"],
    ["start", "--output", "x", "--port", "abc"],
    ["start", "--unknown"],
  ]) {
    expect(() => parse(args, owner)).toThrow();
  }
});

it.each(["SIGINT", "SIGTERM", "end"])(
  "owns a ready lease until %s and removes listeners",
  async (signal) => {
    const h = harness();

    h.host.stdout.write.mockImplementation(() => {
      if (signal === "end") {
        h.host.stdin.end();
      } else {
        h.host.emit(signal);
      }

      return true;
    });

    expect(await main(["serve", "--output", join(owner, "fixture.json")], h.process, h.io)).toBe(0);

    expect(h.host.stdout.write).toHaveBeenCalledWith(
      JSON.stringify({
        status: "ready",
        manifest: join(owner, "fixture.json"),
      }) + "\n",
    );

    expect(h.driver.stop).toHaveBeenCalledOnce();
    expect(h.host.listenerCount("SIGINT")).toBe(0);
    expect(h.host.stdin.listenerCount("end")).toBe(0);
  },
);

it("dispatches persistent start, controls, absence, stop and explicit deletion", async () => {
  const h = harness();
  const output = join(owner, "fixture.json");

  for (const action of ["start", "pause", "unpause", "restart", "assert-absent", "stop", "clean"]) {
    expect(await main([action, "--output", output], h.process, h.io)).toBe(0);
  }

  expect(h.driver.control.mock.calls.map((call) => call[1])).toEqual([
    "pause",
    "unpause",
    "restart",
  ]);

  expect(h.driver.stop.mock.calls.map((call) => call[1])).toEqual([false, true]);

  expect(h.driver.absent).toHaveBeenCalledOnce();
});

it("reports failures without leaking stacks and removes listeners on failed startup", async () => {
  const h = harness();

  h.driver.start.mockRejectedValue(Error("engine unavailable"));

  expect(await main(["serve", "--output", join(owner, "fixture.json")], h.process, h.io)).toBe(1);

  expect(h.host.stderr.write).toHaveBeenCalledWith("testkit: engine unavailable\n");

  expect(h.host.listenerCount("SIGTERM")).toBe(0);

  expect(await main(["stop", "--output", join(owner, "missing.json")], h.process, h.io)).toBe(1);
});

it("exposes recovery without allowing persistent data deletion", async () => {
  const h = harness();
  const output = join(owner, "fixture.json");

  expect(await main(["start", "--output", output], h.process, h.io)).toBe(0);
  expect(await main(["recover", "--output", output], h.process, h.io)).toBe(1);
  expect(h.driver.stop).not.toHaveBeenCalled();
});

it("accepts an explicit immutable image without changing the default", () => {
  expect(
    parse(["start", "--output", "fixture.json", "--image", "sha256:" + "b".repeat(64)], owner)
      .options.image,
  ).toBe("sha256:" + "b".repeat(64));
});
