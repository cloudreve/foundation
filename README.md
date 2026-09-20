# Cloudreve Foundation

The development infrastructure behind Cloudreve projects. Shared code quality, package verification, and isolated Community fixtures—independent of application runtime code.

> [!IMPORTANT]
> Under active development. Features and interfaces may change. Stay tuned for updates.

[Releases](https://github.com/cloudreve/foundation/releases) · [Contributing](CONTRIBUTING.md) · [MIT](LICENSE)

## Packages

| Package                                    | Responsibility                                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------------------- |
| **[@cloudreve/quality](packages/quality)** | ESLint, Prettier, module boundaries, and package artifact verification.                 |
| **[@cloudreve/testkit](packages/testkit)** | Isolated Docker fixtures, lifecycle management, authentication, and storage test setup. |

Both are development dependencies. Each consumer owns its application architecture and platform integrations.

## Install

```sh
bun add --dev https://github.com/cloudreve/foundation/releases/download/v1.0.0/cloudreve-quality-1.0.0.tgz
bun add --dev https://github.com/cloudreve/foundation/releases/download/v1.0.0/cloudreve-testkit-1.0.0.tgz
```

Versioned archives and SHA-256 checksums are available in [releases](https://github.com/cloudreve/foundation/releases).

## Development

Tools are pinned with [mise](https://mise.jdx.dev/); dependencies use Bun.

```sh
mise install
mise run setup
mise run check
mise run package:check
```

---

[Cloudreve](https://github.com/cloudreve/cloudreve) · **Foundation** · [SDK](https://github.com/cloudreve/sdk) · [CLI](https://github.com/cloudreve/cli)
