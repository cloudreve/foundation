import { parseArgs } from "node:util";
import { resolve } from "node:path";
import {
  communityIO,
  startCommunity,
  startDevelopment,
  stopDevelopment,
  controlFixture,
  assertAbsent,
  recoverCommunity,
  readManifest,
  type CommunityIO,
  type StartOptions,
} from "./community.js";

export function parse(args: string[], cwd: string): { action: string; options: StartOptions } {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      output: { type: "string" },
      image: { type: "string" },
      owner: { type: "string" },
      id: { type: "string" },
      role: { type: "string" },
      port: { type: "string" },
      "cors-origin": { type: "string" },
    },
  });

  const action = positionals[0];

  if (
    positionals.length !== 1 ||
    !action ||
    ![
      "serve",
      "start",
      "stop",
      "clean",
      "pause",
      "unpause",
      "restart",
      "assert-absent",
      "recover",
    ].includes(action) ||
    !values.output
  ) {
    throw new Error(
      "Usage: testkit serve|start|stop|clean|pause|unpause|restart|assert-absent|recover --output MANIFEST [--owner ROOT --id ID --role dev|test --port N --cors-origin ORIGIN --image IMMUTABLE_IMAGE]",
    );
  }

  if (values.role && !["dev", "test"].includes(values.role)) {
    throw new Error("Invalid role");
  }

  if (values.port && !/^\d+$/.test(values.port)) {
    throw new Error("Invalid port");
  }

  return {
    action,
    options: {
      owner: resolve(values.owner ?? cwd),
      output: resolve(values.output),
      ...(values.image ? { image: values.image } : {}),
      ...(values.id ? { id: values.id } : {}),
      ...(values.role ? { role: values.role as "dev" | "test" } : {}),
      ...(values.port ? { port: Number(values.port) } : {}),
      ...(values["cors-origin"] ? { corsOrigin: values["cors-origin"] } : {}),
    },
  };
}

export async function main(
  args: string[],
  host = process,
  io: CommunityIO = communityIO,
): Promise<number> {
  let end: () => void = () => {};

  try {
    const { action, options } = parse(args, host.cwd());

    if (action === "serve") {
      const until = new Promise<void>((resolve) => {
        end = resolve;
      });

      host.once("SIGINT", end);
      host.once("SIGTERM", end);
      host.stdin.once("end", end);
      host.stdin.resume();

      const handle = await startCommunity(options, io);

      try {
        host.stdout.write(JSON.stringify({ status: "ready", manifest: options.output }) + "\n");

        await until;
      } finally {
        await handle.close();
      }
    } else if (action === "start") {
      await startDevelopment(options, io);
    } else if (action === "recover") {
      await recoverCommunity(options.output, options.owner, io);
    } else {
      const manifest = await readManifest(options.output, options.owner);

      if (action === "assert-absent") {
        await assertAbsent(manifest, 30_000, io);
      } else if (action === "stop" || action === "clean") {
        await stopDevelopment(manifest, action === "clean", io);
      } else {
        await controlFixture(manifest, action as "pause" | "unpause" | "restart", io);
      }
    }

    return 0;
  } catch (error) {
    host.stderr.write(`testkit: ${(error as Error).message}\n`);

    return 1;
  } finally {
    host.off("SIGINT", end);
    host.off("SIGTERM", end);
    host.stdin.off("end", end);
    host.stdin.pause();
  }
}
