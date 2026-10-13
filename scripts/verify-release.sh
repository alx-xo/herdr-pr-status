#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
tag=${1:?Usage: verify-release.sh <tag>}
test "$tag" = "v$(bun -p "require('./package.json').version")"
test "$(git rev-parse HEAD)" = "$(git rev-parse "refs/tags/$tag^{commit}")"
test -z "$(git status --porcelain)"
