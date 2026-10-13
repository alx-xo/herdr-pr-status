#!/bin/sh
# Herdr runs build hooks in a temporary checkout, then moves it into place.
set -eu
cd "$(dirname "$0")/.."
fail() { echo "PR Status: $*" >&2; exit 1; }
version=$(sed -n 's/^version = "\([0-9][0-9.]*\)"$/\1/p' herdr-plugin.toml)
[ -n "$version" ] || fail 'Cannot determine release version.'
case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail 'Unsupported OS; binary releases support macOS and glibc Linux only.' ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) fail 'Unsupported architecture; binary releases support arm64 and x64 only.' ;;
esac
if [ "$os" = linux ]; then
  getconf GNU_LIBC_VERSION >/dev/null 2>&1 || fail 'Unsupported Linux libc; a glibc system is required (musl is not supported).'
fi
asset="pr-status-$os-$arch"
base="https://github.com/alx-xo/herdr-pr-status/releases/download/v$version"
mkdir -p bin
tmp=$(mktemp -d bin/.install.XXXXXX)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
download() {
  curl --fail --silent --show-error --location --retry 3 --connect-timeout 10 --max-time 120 --proto '=https' --proto-redir '=https' \
    "$base/$1" --output "$tmp/$1" || fail "Download failed for v$version/$1. No matching published binary may exist; install an available exact release or use source development."
}
download SOURCE_COMMIT
revision=$(cat "$tmp/SOURCE_COMMIT")
[ "${#revision}" -eq 40 ] || fail 'Invalid release source commit.'
case "$revision" in *[!0-9a-f]*) fail 'Invalid release source commit.' ;; esac
download SHA256SUMS
download "$asset"
expected=$(awk -v name="$asset" '$2 == name { print $1 }' "$tmp/SHA256SUMS")
[ "${#expected}" -eq 64 ] || fail 'Missing or ambiguous release checksum.'
case "$expected" in *[!0-9a-f]*) fail 'Invalid release checksum.' ;; esac
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$asset" | awk '{print $1}')
else
  actual=$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')
fi
[ "$actual" = "$expected" ] || fail 'Release checksum mismatch; binary was not installed.'
chmod 755 "$tmp/$asset"
unset BUN_BE_BUN
identity=$("./$tmp/$asset" --version) || fail 'Downloaded binary cannot run on this platform.'
[ "$identity" = "pr-status $version ($revision)" ] || fail 'Downloaded binary version/source identity mismatch.'
mv "$tmp/$asset" bin/pr-status
