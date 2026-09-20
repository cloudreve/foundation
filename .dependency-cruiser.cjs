module.exports = {
  forbidden: [
    {
      name: "coordinator-package-exports",
      severity: "error",
      from: { path: "^src/" },
      to: { path: "^packages/", dependencyTypesNot: ["aliased-workspace"] },
    },
    { name: "no-cycles", severity: "error", from: {}, to: { circular: true } },
    {
      name: "no-unresolved",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "no-test-imports",
      severity: "error",
      from: { path: "^(src/|packages/[^/]+/src/)" },
      to: { path: "(^|/)tests/" },
    },
    {
      name: "quality-independent",
      severity: "error",
      from: { path: "^packages/quality/src/" },
      to: {
        path: "^(src/|packages/testkit/)|(^|/)node_modules/(testcontainers|dockerode|@cloudreve/testkit)/",
      },
    },
    {
      name: "testkit-independent",
      severity: "error",
      from: { path: "^packages/testkit/src/" },
      to: {
        path: "^(src/|packages/quality/)|(^|/)node_modules/@cloudreve/(quality|sdk)/",
      },
    },
    {
      name: "no-sibling-source",
      severity: "error",
      from: {},
      to: { path: String.raw`^\.\./cloudreve-` },
    },
  ],
  options: {
    enhancedResolveOptions: {
      conditionNames: ["import", "node", "default", "types"],
      exportsFields: ["exports"],
    },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    doNotFollow: { path: "node_modules|packages/(quality|testkit)/dist" },
  },
};
