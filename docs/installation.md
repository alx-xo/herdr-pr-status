# Installation and updates

Tested toolchain: Herdr **0.9.x** (locally verified CLI: 0.9.1), Bun **1.4.2**,
GitHub CLI (`gh`) **2.101.0**, and Git **2.54.0**. macOS and Linux are supported;
CI checks both. Use a **Nerd Font v3.4-compatible** terminal font for the default icons, or set `"iconSet": "unicode"` for plain Unicode symbols.
Authenticate `gh` for the repositories you want to read before using the plugin.

Install the GitHub source into Herdr's managed plugin directory:

```sh
herdr plugin install alx-xo/herdr-pr-status
```

Then, from a terminal inside your existing Herdr session:

```sh
herdr plugin action invoke alx-xo.pr-status.start
```

Installation registers the plugin; explicit start publishes workspace tokens and
begins polling in that session. Herdr runs the TypeScript source directly with
Bun, not an npm package or compiled artifact. There are no runtime package
dependencies, so users do not need `bun install` or a build step.

See the official [Herdr 0.9.1 plugin documentation](https://github.com/herdrdev/herdr/blob/master/docs/versions/0.9.1/website/src/content/docs/plugins.mdx)
for installation, build and startup behavior.

## Updating or migrating an installation

Registration and the managed checkout are global to the current user, but workers
are session-local. Before replacing source, run these commands inside **each
running Herdr session** using the plugin:

```sh
herdr plugin action invoke alx-xo.pr-status.stop
herdr plugin action invoke alx-xo.pr-status.status
herdr plugin log list --plugin alx-xo.pr-status --limit 3
```

Wait for the stop action's completed log, then check the completed status log for
`running: false`. Action acceptance alone is not shutdown confirmation; repeat
status and log checks if necessary. Only after all session workers have stopped:

- **Managed update:** rerun `herdr plugin install alx-xo/herdr-pr-status`.
  Herdr replaces the managed checkout; there is no separate update command.
- **Local-link migration:** run `herdr plugin unlink alx-xo.pr-status`, then
  `herdr plugin install alx-xo/herdr-pr-status`. Installing over a local link is
  refused. Unlink leaves the local checkout files alone.

Existing plugin config and state remain in place. Do not overwrite your active
sidebar layout. After installation, explicitly invoke `alx-xo.pr-status.start` in
each running session that should poll. Do not kill or restart the Herdr server.
