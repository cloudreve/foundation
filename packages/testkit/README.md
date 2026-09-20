# @cloudreve/testkit

Development fixtures and Docker adapters for Cloudreve projects. **Development dependency only.**

```sh
bun add --dev @cloudreve/testkit
```

`@cloudreve/testkit/community` exposes isolated fixture lifecycle functions.
`@cloudreve/testkit/linux-docker` provides adapters for Linux GitHub Actions and `act`:

```js
import { communityIO, startCommunity } from "@cloudreve/testkit/community";
import { linuxDockerDriver } from "@cloudreve/testkit/linux-docker";

const adapter = linuxDockerDriver("ci-example");
const lease = await startCommunity(
  { owner: process.cwd(), output: ".artifacts/fixture.json" },
  { ...communityIO, driver: adapter.driver },
);
try {
  console.log(lease.manifest.endpoint);
} finally {
  await lease.close();
}
```

Fixtures verify ownership before cleanup, publish only loopback ports on native
Linux runners, and use isolated Docker networks inside job containers. Docker
must be available locally. [Development and compatibility checks](https://github.com/cloudreve/foundation).
