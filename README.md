# Cloudreve Foundation

Shared development infrastructure for Cloudreve projects. Independent packages for code quality, package verification, and isolated Community test fixtures.

| Package                                  | Scope                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| [`@cloudreve/quality`](packages/quality) | ESLint, Prettier, module boundaries, artifact verification                |
| [`@cloudreve/testkit`](packages/testkit) | Fixture lifecycle, Docker adapters, authentication and storage test setup |

Foundation packages are development dependencies. Application runtime code and platform integrations belong to their respective projects.

## Installation

```sh
bun add --dev @cloudreve/quality @cloudreve/testkit
```

Before registry publication, versioned tarballs and SHA-256 checksums provide the same package boundary. SDK and CLI consume these artifacts without sibling source imports.

## Development

```sh
mise install
mise run setup
mise run check
mise run package:check
```

`mise run format` applies shared formatting rules. Checks include lint, types, module boundaries, package consumers, and a 95% minimum for statements, branches, functions, and lines across all production code.

## Docker validation

```sh
mise run test:e2e
mise run ci:local -- --job community
```

Native Docker tests cover persistent and ephemeral fixture lifecycle, isolation, recovery, and cleanup. CI validates the Linux Docker adapter against pinned Community versions. Test state and reports stay under `.artifacts/`.

[Architecture and contribution guide](CONTRIBUTING.md) · [MIT license](LICENSE)
