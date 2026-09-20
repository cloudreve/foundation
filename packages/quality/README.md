# @cloudreve/quality

Shared development policies for [Cloudreve](https://github.com/cloudreve/foundation).
A **development dependency**, separate from application runtime code.

```js
// eslint.config.mjs
import { nodeConfig, modernJavaScript, structuralSpacing } from "@cloudreve/quality/eslint";

export default [...nodeConfig, modernJavaScript, structuralSpacing];
```

`sdkConfig` applies portable-source boundaries.
`createTypedConfig(import.meta.dirname)` enables type-aware promise and import checks.
Module maps and platform exceptions remain in each consumer.

```js
// prettier.config.mjs
export { default } from "@cloudreve/quality/prettier";
```

| Export         | Purpose                                                          |
| -------------- | ---------------------------------------------------------------- |
| `eslint`       | Node and portable SDK rules, structural spacing, typed checks    |
| `prettier`     | Shared 100-column formatting                                     |
| `dependencies` | Dependency-cruiser rules from a project's module map             |
| `artifacts`    | Validate, checksum, vendor and verify installed package archives |

Archive verification requires the system `tar` command. MIT licensed.
