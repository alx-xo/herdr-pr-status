# Contributing

## Local development

For local development, clone into a permanent directory: Herdr links this
checkout, so do not move or delete it while linked.

```sh
git clone https://github.com/alx-xo/herdr-pr-status.git
cd herdr-pr-status
bun install --frozen-lockfile
touch .pr-status-source
herdr plugin link .
```

Create `.pr-status-source` in your linked checkout to run directly from source.
It is ignored by Git and should not be added to managed installations.

Linking does not run build hooks. In an existing Herdr session, explicitly invoke
`herdr plugin action invoke alx-xo.pr-status.start`. Development checks:

```sh
bun run typecheck
bun test
bun run build
bun dist/main.js info
bun run build:binary
bun run test:integration:binary
```

Unit tests use injected command runners rather than live GitHub or Herdr writes.
`build` produces Bun-targeted JavaScript; `build:binary` compiles a standalone
executable for your machine into `dist/releases`. To cross-compile, pass
`darwin-arm64`, `darwin-x64`, `linux-arm64`, or `linux-x64`.

## Isolated Herdr integration check

```sh
bun run test:integration
bun run test:integration:binary
```

Verifies automatic startup, PR badge publication, and clean shutdown in isolated
Herdr on Linux and macOS. The suite runs separately from `bun test`.
Binary mode tests the standalone plugin without Bun or Node on its runtime PATH.
Pass `--binary <path>` to test an existing binary. Your normal Herdr configuration
and sessions are untouched. The test harness itself requires Bun.

### Local setup

Install **Herdr 0.9.3**, Bun, Git, and `ps`. The runtime also requires Bun FFI,
local loopback/Unix sockets, PTYs, and `/bin/sh`. The runner validates its
prerequisites and Herdr version before starting.

### Test sequence

1. Link the **current checkout** into a temporary Herdr registry and start its
   server. The manifest startup hook launches the plugin worker.
2. Use a disposable Git repository and fixture-backed `gh` to supply an open PR
   with passing checks, an approval, and an unresolved review thread.
3. Read back the four expected PR badge values through Herdr's workspace API.
4. Wait for the stop action to succeed and report `running=false`, then verify
   worker, server, and endpoint cleanup.

Each child uses an allowlisted environment, private HOME/XDG/Git/GitHub
configuration, a private socket, and a controlled shell. GitHub responses come
from the fixture, which validates supported read requests. Cleanup verifies
process ownership before sending fallback signals and removes temporary state
once shutdown is confirmed. If cleanup fails, the runner retains private recovery
state and reports its location with bounded, sanitized diagnostics.

### Continuous integration

Pull requests and pushes to `main` run tests, typechecks, and builds on Linux and
macOS. Source and standalone lifecycle checks run on macOS 15 and Ubuntu 24.04,
each on arm64 and x64. All four targets must pass the required lifecycle checks.
Tested binaries are uploaded as CI artifacts.

See [ci.yml](.github/workflows/ci.yml) for pinned tool versions and runner settings.

## Release checklist

- [ ] Choose the release version and update `package.json` and `herdr-plugin.toml`
  together in a PR. Use a `v`-prefixed tag matching that version.
- [ ] Run the development checks above and wait for PR CI on macOS and Linux.
- [ ] Smoke-test in Herdr: install/start, verify sidebar status, stop/restart, and
  follow the [update procedure](docs/installation.md#updating-or-migrating-an-installation).
  For changes to polling or session handling, include the relevant recovery and
  multiple-session checks. Record tested OS/tool versions and results in the
  release PR, distinguishing automated checks from manual verification.
- [ ] Merge through the repository's review policy. Wait for macOS and Linux CI
  on the exact merged commit that will be released.
- [ ] Create the matching tag from that verified commit SHA,
  not a moving branch tip. Include user-visible changes, known limitations, a
  comparison link to the previous release, and the update instructions.
- [ ] Manually dispatch **Prepare release artifacts** with that tag. It checks
  version/tag identity, runs the native matrix, and assembles `release-assets`
  containing four binaries, `SOURCE_COMMIT`, and verified `SHA256SUMS`.
- [ ] Attach the contents of `release-assets` to the
  matching GitHub release (not the CI zip), then publish it. Do not advertise
  the tag before all assets are attached. Link the
  [installation guide](docs/installation.md), which explains `main` installs and
  selecting a release with `--ref`.
- [ ] Replace `<published-tag>` in the README and installation guide with the
  release tag when preparing the release.
- [ ] Confirm the published tag points to the intended commit and both version
  fields match it.
