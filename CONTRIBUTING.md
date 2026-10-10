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

Modules separate bounded subprocess execution, read-only GitHub lookup, pure formatting, Herdr discovery/publishing, and orchestration. Tests use injected command runners rather than live GitHub/Herdr writes. The optional build produces Bun-targeted JavaScript; Herdr itself invokes `bun src/main.ts` directly.

## Release checklist

- [ ] Choose the release version and update `package.json` and `herdr-plugin.toml`
  together in a PR. Use a `v`-prefixed tag matching that version.
- [ ] Run the development checks above and wait for PR CI on macOS and Linux.
- [ ] Smoke-test in Herdr: install/start, verify sidebar status, stop/restart, and
  follow the [update procedure](docs/installation.md#updating-or-migrating-an-installation).
  For a beta milestone, also check multiple sessions, sleep/wake, network recovery,
  and authentication failures. Record the tested OS/tool versions and results in
  the release PR; distinguish automated checks from manual verification and note
  anything not tested.
- [ ] Merge through the repository's review policy. Wait for macOS and Linux CI
  on the exact merged commit that will be released.
- [ ] Create the matching tag and GitHub release from that verified commit SHA,
  not a moving branch tip. Include user-visible changes, known limitations, a
  comparison link to the previous release, and the update instructions.
- [ ] For a beta, mark the GitHub release as a prerelease. Do not assume this
  controls what Herdr installs; verify installer revision selection before
  promising a separate beta channel.
- [ ] Confirm the published tag points to the intended commit and both version
  fields match it.
