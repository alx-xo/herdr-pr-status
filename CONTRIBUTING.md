# Contributing

## Local development

For local development, clone into a permanent directory: Herdr links this
checkout, so do not move or delete it while linked.

```sh
git clone https://github.com/alx-xo/herdr-pr-status.git
cd herdr-pr-status
bun install --frozen-lockfile
herdr plugin link .
```

Linking does not run build hooks. In an existing Herdr session, explicitly invoke
`herdr plugin action invoke alx-xo.pr-status.start`. Development checks:

```sh
bun run typecheck
bun test
bun run build
bun dist/main.js info
```

Modules separate bounded subprocess execution, read-only GitHub lookup, pure formatting, Herdr discovery/publishing, and orchestration. Unit tests use injected command runners rather than live GitHub/Herdr writes. The optional build produces Bun-targeted JavaScript; Herdr itself invokes `bun src/main.ts` directly.

## Isolated Herdr integration check

```sh
bun run test:integration
```

Verifies automatic startup, PR badge publication, and clean shutdown in isolated
Herdr on Linux and macOS. The suite runs separately from `bun test`.

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

Pull requests and pushes to `main` run four checks:

| Check | Purpose |
| --- | --- |
| Tests, types & build / Linux | Unit tests, TypeScript checks, and build |
| Tests, types & build / macOS | The same checks on macOS |
| Herdr startup, PR badges & shutdown / Linux | The integration scenario above |
| Herdr startup, PR badges & shutdown / macOS | The same scenario on macOS |

Integration jobs use Bun **1.4.2**, a frozen dependency install, and Herdr
**0.9.3**, with a 15-minute timeout per runner. Provisioning downloads the binary
for the runner's OS/architecture, verifies its pinned SHA256, and checks its
version. Checksums and their upstream source are recorded in
`.github/workflows/ci.yml`.

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
- [ ] Create the matching tag and GitHub release from that verified commit SHA,
  not a moving branch tip. Include user-visible changes, known limitations, a
  comparison link to the previous release, and the update instructions.
- [ ] Publish a normal GitHub release. Link the
  [installation guide](docs/installation.md), which explains `main` installs and
  selecting a release with `--ref`.
- [ ] Confirm the published tag points to the intended commit and both version
  fields match it.
