# Installation, updates, and removal

## Standalone release installs

Requires **Herdr 0.9.0+**, **Git**, and authenticated **GitHub CLI (`gh`)**.
Bun and Node are not required. Installation also needs a POSIX shell, `curl`,
and `sha256sum` or `shasum`.

Install a release with:

```sh
herdr plugin install --ref v1.0.0 alx-xo/herdr-pr-status
```

Find available versions on the
[releases page](https://github.com/alx-xo/herdr-pr-status/releases).
Always include `--ref` when installing or updating. Without it, Herdr downloads
`main`, which may not have a matching binary.

Then, inside your existing Herdr session:

```sh
herdr plugin action invoke alx-xo.pr-status.start
```

Use a **Nerd Font v3.4-compatible** font, or configure `"iconSet": "unicode"`.

### Platform compatibility

Standalone releases target macOS and **glibc Linux**, each on arm64 and x64.
Alpine/musl Linux and Windows are not supported. CI targets macOS 15 and
Ubuntu 24.04. Older systems are outside the tested platform matrix.
macOS binaries are not signed or notarized.

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

- **Managed update:** rerun `herdr plugin install --ref v1.0.0 alx-xo/herdr-pr-status`.
  Herdr replaces the managed checkout; there is no separate update command.
- **Local-link migration:** run `herdr plugin unlink alx-xo.pr-status`, then
  `herdr plugin install --ref v1.0.0 alx-xo/herdr-pr-status`. Installing over a local link is
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
