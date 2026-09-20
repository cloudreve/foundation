import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  startCommunity,
  startDevelopment,
  stopDevelopment,
  controlFixture,
  assertAbsent,
  communityIO,
  recoverCommunity,
} from "@cloudreve/testkit/community";

const root = process.cwd();
const directory = resolve(".artifacts", `isolation-${randomUUID()}`);
const live = [];

await mkdir(directory, { recursive: true });

try {
  const first = await startCommunity({
    owner: root,
    output: resolve(directory, "one/fixture.json"),
  });

  live.push(first);

  const one = first.manifest;

  const second = await startCommunity({
    owner: root,
    output: resolve(directory, "two/fixture.json"),
  });

  live.push(second);

  const two = second.manifest;

  assert.notEqual(one.id, two.id);
  assert.notEqual(one.endpoint, two.endpoint);
  assert.notEqual(one.volume, two.volume);
  assert.notEqual(one.network, two.network);

  const credentials = JSON.parse(await readFile(one.credentialsFile, "utf8"));

  const login = async (fixture) =>
    fetch(`${fixture.endpoint}/api/v4/session/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(credentials),
    }).then((r) => r.json());

  assert.equal((await login(one)).code, 0);
  assert.notEqual((await login(two)).code, 0);
  await first.close();
  live.splice(0, 1);

  assert.equal((await fetch(`${two.endpoint}/api/v4/site/ping`).then((r) => r.json())).code, 0);

  await assertAbsent(one);
  await controlFixture(two, "stop");
  await controlFixture(two, "start");
  await communityIO.driver.ready(two);
  await controlFixture(two, "pause");
  await controlFixture(two, "unpause");
  await controlFixture(two, "restart");
  await communityIO.driver.ready(two);

  await assert.rejects(
    controlFixture({ ...two, owner: resolve(root, "foreign") }, "stop"),
    /another fixture/,
  );

  const persistentOutput = resolve(directory, "dev/fixture.json");
  const dev = await startDevelopment({ owner: root, output: persistentOutput });

  try {
    const before = await readFile(dev.credentialsFile, "utf8");
    const savedManifest = await readFile(persistentOutput, "utf8");

    await assert.rejects(startCommunity({ owner: root, output: persistentOutput }), /persistent/);

    assert.equal(await readFile(persistentOutput, "utf8"), savedManifest);
    await stopDevelopment(dev);

    const restored = await startDevelopment({
      owner: root,
      output: persistentOutput,
    });

    assert.equal(restored.volume, dev.volume);
    assert.equal(restored.containerId, dev.containerId);
    assert.equal(await readFile(restored.credentialsFile, "utf8"), before);

    await assert.rejects(
      startDevelopment(
        { owner: root, output: persistentOutput },
        {
          ...communityIO,
          seed: async () => {
            throw Error("forced seed failure");
          },
        },
      ),
      /forced seed failure/,
    );

    assert.equal((await fetch(dev.endpoint + "/api/v4/site/ping").then((r) => r.json())).code, 0);

    await startDevelopment({ owner: root, output: persistentOutput });
  } finally {
    await stopDevelopment(dev, true);
  }

  await assertAbsent(dev);

  const failedOutput = resolve(directory, "failure/fixture.json");

  await assert.rejects(
    startCommunity(
      { owner: root, output: failedOutput },
      {
        ...communityIO,
        seed: async () => {
          throw Error("forced seed failure");
        },
      },
    ),
    /forced seed failure/,
  );

  await assertAbsent(JSON.parse(await readFile(failedOutput, "utf8")));

  const crashOutput = resolve(directory, "crash/fixture.json");

  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import {main} from "@cloudreve/testkit/command";process.exitCode=await main(process.argv.slice(1));',
      "--",
      "serve",
      "--output",
      crashOutput,
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );

  try {
    await once(child.stdout, "data", { signal: AbortSignal.timeout(180_000) });

    await assert.rejects(recoverCommunity(crashOutput, root), {
      code: "ELOCKED",
    });

    child.kill("SIGKILL");
    await once(child, "exit");

    const deadline = Date.now() + 40_000;

    while (true) {
      try {
        await recoverCommunity(crashOutput, root);
        break;
      } catch (error) {
        if (error.code !== "ELOCKED" || Date.now() >= deadline) {
          throw error;
        }

        await delay(500);
      }
    }

    await assertAbsent(JSON.parse(await readFile(crashOutput, "utf8")));

    assert.equal((await fetch(two.endpoint + "/api/v4/site/ping").then((r) => r.json())).code, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  }

  const report = {
    passed: true,
    checks: [
      "distinct container/port/volume/network",
      "credentials isolated",
      "cleanup preserves sibling",
      "ownership-checked stop/start/pause/unpause/restart",
      "persistent restart preserves container, volume and credentials",
      "persistent seeding failure retains data and recovers",
      "ephemeral seeding failure removes all project resources",
      "live lease refuses recovery; SIGKILL recovery removes only expired owned resources",
    ],
    image: one.image,
  };

  await writeFile(resolve(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");

  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const fixture of live) {
    await fixture.close();
  }
}
