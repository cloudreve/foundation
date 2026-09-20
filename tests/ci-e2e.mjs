import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startCommunity, communityIO } from "@cloudreve/testkit/community";
import { linuxDockerDriver } from "@cloudreve/testkit/linux-docker";

const targets = JSON.parse(await readFile("tooling/ci/community.json", "utf8"));
const version = process.env.CR_CI_VERSION ?? "4.18.0";
const target = targets.find((entry) => entry.version === version);

assert(target, "CR_CI_VERSION must select a pinned Community version");

const runId = process.env.CR_CI_RUN_ID ?? `foundation-ci-${randomUUID()}`;
const directory = resolve(".artifacts/runtime", runId);
const adapter = linuxDockerDriver(runId);
const io = { driver: adapter.driver, seed: communityIO.seed };
const leases = [];
const receipt = { version, image: target.image, passed: false, cleanupPassed: false };

await mkdir(directory, { recursive: true, mode: 0o700 });

const start = async (name) => {
  const lease = await startCommunity(
    { owner: process.cwd(), output: resolve(directory, name, "fixture.json"), image: target.image },
    io,
  );

  leases.push(lease);

  return lease;
};

try {
  const first = await start("first");
  const second = await start("second");

  assert.notEqual(first.manifest.endpoint, second.manifest.endpoint);
  assert.notEqual(first.manifest.volume, second.manifest.volume);
  assert.notEqual(first.manifest.network, second.manifest.network);

  const credentials = JSON.parse(await readFile(first.manifest.credentialsFile, "utf8"));

  const login = async (fixture) => {
    const response = await fetch(fixture.endpoint + "/api/v4/session/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(credentials),
    });

    return response.json();
  };

  assert.equal((await login(first.manifest)).code, 0);
  assert.notEqual((await login(second.manifest)).code, 0);

  await assert.rejects(
    io.driver.control({ ...second.manifest, owner: "foreign" }, "stop"),
    /Foreign/,
  );

  await io.driver.control(second.manifest, "restart");
  await io.driver.ready(second.manifest);
  await first.close();
  assert(await io.driver.absent(first.manifest));

  assert.equal(
    (
      await fetch(second.manifest.endpoint + "/api/v4/site/ping").then((response) =>
        response.json(),
      )
    ).code,
    0,
  );

  const failedOutput = resolve(directory, "failure", "fixture.json");

  await assert.rejects(
    startCommunity(
      { owner: process.cwd(), output: failedOutput, image: target.image },
      {
        driver: io.driver,
        seed: async () => {
          throw new Error("Forced seed failure");
        },
      },
    ),
    /Forced seed failure/,
  );

  assert(await io.driver.absent(JSON.parse(await readFile(failedOutput, "utf8"))));
  receipt.passed = true;
} finally {
  for (const lease of leases) {
    await lease.close();
    assert(await io.driver.absent(lease.manifest));
  }

  receipt.cleanupPassed = true;
  await mkdir(".artifacts/ci", { recursive: true });
  await writeFile(`.artifacts/ci/community-${version}.json`, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
}
