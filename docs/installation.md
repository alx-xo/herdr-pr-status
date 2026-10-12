# Installation, updates, and removal

Verified toolchain: Herdr **0.9.3**, Bun **1.4.2** in CI and **1.4.3** locally,
GitHub CLI (`gh`) **2.102.0**, and Git **2.54.0**. macOS and Linux are supported;
CI checks both. Use a **Nerd Font v3.4-compatible** terminal font for the default icons, or set `"iconSet": "unicode"` for plain Unicode symbols.
Authenticate `gh` for the repositories you want to read before using the plugin.

Install the GitHub source into Herdr's managed plugin directory:

```sh
herdr plugin install alx-xo/herdr-pr-status
```

The standard install fetches the latest commit on `main`. To select a specific
release, use its tag instead:

```sh
herdr plugin install --ref v0.5.0 alx-xo/herdr-pr-status
```

Include `--ref` each time you want to select a release; a later install without
it fetches `main` again. For an existing installation, follow the
[update procedure](#updating-or-migrating-an-installation) before reinstalling.

Then, from a terminal inside your existing Herdr session:

```sh
herdr plugin action invoke alx-xo.pr-status.start
```

Installation registers the plugin; explicit start publishes workspace tokens and
begins polling in that session. Herdr runs the TypeScript source directly with
Bun, not an npm package or compiled artifact. There are no runtime package
dependencies, so users do not need `bun install` or a build step.

See the official [plugin documentation bundled with Herdr 0.9.3](https://github.com/herdrdev/herdr/blob/v0.9.3/docs/versions/0.9.1/website/src/content/docs/plugins.mdx)
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

## Uninstalling

First, stop the worker in **each running Herdr session** using the stop/status/log
commands in the [update procedure](#updating-or-migrating-an-installation). Wait
for the stop action to finish successfully and status to report `running: false`
for every session.

Then run the appropriate command once:

- **Managed installation:**
  ```sh
  herdr plugin uninstall alx-xo.pr-status
  ```
  Removes the registration and Herdr-managed checkout.
- **Local link:**
  ```sh
  herdr plugin unlink alx-xo.pr-status
  ```
  Removes the registration and preserves your local checkout.

Plugin configuration and state are retained for a future installation. Existing
workspace badge values and sidebar settings also remain. If you added custom
[sidebar rows](sidebar.md), remove the `$pr`, `$pr_checks`, `$pr_review`, and
`$pr_threads` entries from those rows, keeping your other workspace settings.
