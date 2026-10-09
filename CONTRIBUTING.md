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
