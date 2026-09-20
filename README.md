# Cloudreve Foundation

> [!IMPORTANT]
> Under active development. Features and interfaces may change. Stay tuned for updates.

Shared development infrastructure for Cloudreve projects. Independent packages for code quality, package verification, and isolated Community test fixtures.

| Package                                  | Scope                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| [`@cloudreve/quality`](packages/quality) | ESLint, Prettier, module boundaries, artifact verification                |
| [`@cloudreve/testkit`](packages/testkit) | Fixture lifecycle, Docker adapters, authentication and storage test setup |

Foundation packages are development dependencies. Application runtime code and platform integrations belong to their respective projects.

## Installation

```sh
bun add --dev https://github.com/cloudreve/foundation/releases/download/v1.0.0/cloudreve-quality-1.0.0.tgz
bun add --dev https://github.com/cloudreve/foundation/releases/download/v1.0.0/cloudreve-testkit-1.0.0.tgz
```

[Releases](https://github.com/cloudreve/foundation/releases) include versioned tarballs and SHA-256 checksums. SDK and CLI consume these development packages without sibling source imports.

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
mise run ci:local -- --job quality --matrix os:ubuntu-latest
```

Native Docker tests cover persistent and ephemeral fixture lifecycle, isolation, recovery, and cleanup. GitHub Actions runs unit, build, and package checks on Linux, macOS, and Windows. Docker lifecycle checks run separately on Linux. Test state and reports stay under `.artifacts/`.

[Architecture and contribution guide](CONTRIBUTING.md) · [MIT license](LICENSE)

The release workflow accepts an explicit stable version or a patch, minor, or major increment. All three platforms validate the exact candidate before one GitHub release is created.
