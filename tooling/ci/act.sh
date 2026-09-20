#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "$0")/../.." && pwd -P)
cd "$repo_root"
export CR_CI_PARENT_RUN_ID="foundation-act-$(date +%s)-$$"
finish() {
  result=$?
  trap - EXIT
  if ! CR_CI_CLEANUP_PARENT=1 bash tooling/ci/cleanup.sh; then result=1; fi
  exit "$result"
}
trap finish EXIT
export DOCKER_HOST="${DOCKER_HOST:-$(docker context inspect "$(docker context show)" --format '{{.Endpoints.docker.Host}}')}"
mise exec act@0.2.89 -- act --workflows .github/workflows/ci.yml \
  --artifact-server-path "$repo_root/.artifacts/act" --env "CR_CI_PARENT_RUN_ID=$CR_CI_PARENT_RUN_ID" "$@"
