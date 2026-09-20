import { expect, it } from "vitest";
import { createServer } from "node:http";
import { assertOwned, serviceFailureDetails, loopbackBridge } from "../src/linux-docker.js";

it("requires all ownership labels before accepting a Docker resource", () => {
  const fixture = { owner: "/work/cli", id: "ci-123", role: "test" };

  const labels = {
    "dev.cloudreve.worktree": fixture.owner,
    "dev.cloudreve.fixture": fixture.id,
    "dev.cloudreve.role": "test",
  };

  expect(() => assertOwned({ Config: { Labels: labels } }, fixture)).not.toThrow();

  for (const key of Object.keys(labels)) {
    expect(() => assertOwned({ Labels: { ...labels, [key]: "foreign" } }, fixture)).toThrow();
  }
});

it("streams actual bytes over the job-local bridge and closes active sockets", async () => {
  const expected = Buffer.alloc(262144, 73);
  const upstream = createServer((_request, response) => response.end(expected));

  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));

  const port = (upstream.address() as { port: number }).port;
  const bridge = await loopbackBridge("127.0.0.1", port);

  try {
    const response = await fetch(bridge.endpoint);

    expect(Buffer.from(await response.arrayBuffer())).toEqual(expected);
  } finally {
    await bridge.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }

  await expect(fetch(bridge.endpoint)).rejects.toThrow();
});

it("closes a refused upstream and keeps connected streams alive beyond the connect deadline", async () => {
  const stopped = createServer();

  await new Promise<void>((resolve) => stopped.listen(0, "127.0.0.1", resolve));

  const port = (stopped.address() as { port: number }).port;
  const refused = await loopbackBridge("127.0.0.1", port);

  await new Promise<void>((resolve) => stopped.close(() => resolve()));

  try {
    await expect(fetch(refused.endpoint, { signal: AbortSignal.timeout(2000) })).rejects.toThrow(
      "fetch failed",
    );
  } finally {
    await refused.close();
  }

  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "Content-Length": "2" });
    response.write("a");

    const timer = setTimeout(() => response.end("b"), 5500);

    response.once("close", () => clearTimeout(timer));
  });

  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));

  const bridge = await loopbackBridge("127.0.0.1", (upstream.address() as { port: number }).port);

  try {
    expect(await (await fetch(bridge.endpoint)).text()).toBe("ab");
  } finally {
    await bridge.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}, 10000);

it("resets active connections while preserving the listener for recovery", async () => {
  let count = 0;

  const upstream = createServer((_request, response) => {
    if (++count === 1) {
      response.writeHead(200, { "Content-Length": "100" });
      response.write("a");
    } else {
      response.end("recovered");
    }
  });

  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));

  const bridge = await loopbackBridge("127.0.0.1", (upstream.address() as { port: number }).port);

  try {
    const response = await fetch(bridge.endpoint);
    const body = response.text();

    bridge.disconnect();
    await expect(body).rejects.toThrow();
    expect(await (await fetch(bridge.endpoint)).text()).toBe("recovered");
  } finally {
    await bridge.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

it("retains bounded process diagnostics without service credentials or capability URLs", () => {
  const message = serviceFailureDetails(
    "search",
    { ExitCode: 137, OOMKilled: true, Error: "" },
    "MEILI_MASTER_KEY=DoNotRetain123\nHTTP https://owned.test/?secret=abc\nfatal allocation failure",
  );

  expect(message).toContain("exit=137, oom=true");
  expect(message).toContain("fatal allocation failure");
  expect(message).not.toContain("DoNotRetain123");
  expect(message).not.toContain("owned.test");

  expect(
    serviceFailureDetails("search", { ExitCode: 1, OOMKilled: false }, "x".repeat(20000)).length,
  ).toBeLessThan(4100);
});

it("closes earlier listeners if a later bind fails and rejects empty bindings", async () => {
  await expect(loopbackBridge("127.0.0.1", 1, [])).rejects.toThrow("bind address");
  await expect(loopbackBridge("127.0.0.1", 1, ["127.0.0.1", "invalid-address"])).rejects.toThrow();
  expect(() => assertOwned(null, { owner: "/work", id: "missing" })).toThrow();
});
