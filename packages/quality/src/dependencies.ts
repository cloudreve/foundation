export interface LayerMap {
  [name: string]: readonly string[];
}

/** Shared module rules; each repo retains the map of its actual modules. */
export function moduleRules(layers: LayerMap, root = "src") {
  if (!/^[a-z][a-z0-9/-]*$/.test(root) || root.includes("..")) {
    throw new Error("Invalid module root");
  }

  const names = Object.keys(layers);

  if (!names.length || names.some((n) => !/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/.test(n))) {
    throw new Error("Invalid layer names");
  }

  for (const [name, deps] of Object.entries(layers)) {
    if (deps.some((d) => d === name || !names.includes(d))) {
      throw new Error("Unknown or self dependency");
    }
  }

  return [
    { name: "no-cycles", severity: "error", from: {}, to: { circular: true } },
    {
      name: "no-unresolved",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    ...Object.entries(layers).map(([name, deps]) => ({
      name: `${name}-public-dependencies`,
      severity: "error",
      from: { path: `^${root}/${name}/` },
      to: {
        path: `^${root}/`,
        pathNot: `^${root}/(?:${name}/|(?:${deps.join("|") || "__none__"})/index\\.[cm]?[jt]s$)`,
      },
    })),
  ];
}

/** Restrict SDK modules to their declared public dependencies and portable runtime packages. */
export function sdkRules(layers: LayerMap, runtimePackages: readonly string[] = []) {
  if (runtimePackages.some((name) => !/^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(name))) {
    throw new Error("Invalid runtime package");
  }

  const packages = runtimePackages.map((name) => name.replaceAll(".", "\\.")).join("|");

  return [
    ...moduleRules(layers),
    {
      name: "sdk-is-portable",
      severity: "error",
      from: { path: "^src/" },
      to: {
        pathNot: `^src/${packages ? `|(?:^|/)node_modules/(?:${packages})/` : ""}`,
      },
    },
  ];
}
