# Development

## Package boundaries

`packages/quality` owns static policy and artifact verification. It has no Docker dependency. `packages/testkit` owns test infrastructure and has no SDK or application dependency. Cross-package source imports and circular dependencies are rejected by architecture checks.

Consumer repositories own their module maps, platform adapters, commands, and product scenarios. Shared packages provide the policy and fixture mechanisms through explicit exports. Foundation is not bundled into consumer release artifacts.

## Validation

Dependency lifecycle scripts are disabled during installation. Project builds run explicitly through mise; optional native dependency optimizations are not required for these checks.

```sh
mise run format
mise run check
mise run package:check
```

All production sources are included in coverage with 95% minimum statements, branches, functions, and lines. Tests cover public behavior, invalid inputs, ownership checks, and cleanup failures. New public exports require package-consumer verification.

Formatting uses two-space indentation, 100-column wrapping, explicit control-flow braces, one variable per declaration, and blank lines between logical sections. Related short declarations stay grouped. ESLint and Prettier run through the same mise tasks locally and in CI.

## Fixtures

`startCommunity` creates an isolated ephemeral fixture and returns its teardown function. `startDevelopment` and `stopDevelopment` manage persistent development fixtures. The Linux adapter supports both native Linux and containerized CI runners without sharing host source paths.

Every resource carries owner and fixture labels. Cleanup verifies ownership before changing Docker state. Source-level CI cleanup scripts remain available when dependency installation fails. Tests use disposable accounts; credentials and raw fixture state remain local.

## Packages

`mise run package:check` packs each workspace, installs it into a separate temporary consumer, verifies installed bytes and public exports, and writes checksummed artifacts under `.artifacts/packages/`. Consumers update vendored artifacts and lockfiles explicitly.

Release tags match the workspace version. Release workflows prepare artifacts for review; registry publication is a separate operation.
