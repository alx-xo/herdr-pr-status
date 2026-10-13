#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# Herdr 0.9.3 exports ROOT/CONFIG/STATE, not install source kind. Never infer
# development from a missing/broken binary, Git metadata, or runtime availability.
unset BUN_BE_BUN
if [ -f .pr-status-source ]; then
  command -v bun >/dev/null 2>&1 || { echo 'PR Status: source development requires Bun on PATH.' >&2; exit 1; }
  exec bun src/main.ts "$@"
fi
[ -x bin/pr-status ] || {
  echo 'PR Status: Missing binary. Install an available exact release; for a local source link explicitly create .pr-status-source in that checkout.' >&2
  exit 1
}
exec ./bin/pr-status "$@"
