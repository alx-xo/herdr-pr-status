# herdr-pr-status

An early-stage public PR-status plugin for Herdr 0.9.0+, written in TypeScript and run directly with Bun. Requires Git and authenticated `gh`. Includes manual refresh and configurable polling. No GitHub writes, cache, or sidebar-layout changes.

![Herdr PR badges showing 44/44 checks with approval and 12 unresolved threads, and 46/46 checks awaiting review](docs/images/pr-status.png)

*Actual Herdr sidebar showing PR checks, review states, and unresolved threads. Colors follow the user's sidebar configuration.*

## Requirements and installation

Tested toolchain: Herdr **0.9.x** (locally verified CLI: 0.9.1), Bun **1.4.2**,
GitHub CLI (`gh`) **2.101.0**, and Git **2.54.0**. macOS and Linux are supported;
CI checks both. Use a **Nerd Font v3.4-compatible** terminal font for the default icons.
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

Use Herdr actions for diagnostics and control without entering the managed
checkout. `info` is local; `preview` reads GitHub without metadata writes:

```sh
herdr plugin action invoke alx-xo.pr-status.info
herdr plugin action invoke alx-xo.pr-status.preview
herdr plugin action invoke alx-xo.pr-status.refresh
herdr plugin action invoke alx-xo.pr-status.start
herdr plugin action invoke alx-xo.pr-status.status
herdr plugin action invoke alx-xo.pr-status.stop
herdr plugin log list --plugin alx-xo.pr-status --limit 3
```

Action acceptance only means the process started. Check the completed log and sidebar. Preview/refresh print one result per workspace and exit nonzero if any workspace failed; successful workspaces still update. Unsupported or ambiguous checkout discovery is explicitly skipped. Lookup failure preserves old metadata, so existing badges may be stale until the next successful refresh.

**Before switching from another PR plugin:** disable its registration and stop its specific detached poller, if any. Shared token names can otherwise compete. Herdr tokens are per-workspace, last-update-wins patches, not per-source overlays. This plugin sets or clears only the four familiar PR tokens; unrelated tokens are left alone. Other plugins and sidebar layout are not changed automatically.

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

## Polling

Background workspaces use `pollSeconds` (**60 seconds** by default); the active workspace uses `activePollSeconds` (**30 seconds** by default). Both are integers from **15 to 3600**, measured after each workspace refresh completes. Refreshes never overlap. Local branch checks run every 2 seconds for the active workspace and on both sides of a focus change; unchanged branches do not trigger extra GitHub requests.

Polling uses a one-shot Herdr startup hook to launch a session-scoped worker. Installing, linking or enabling a plugin does not run startup hooks, so an already-running Herdr session needs the start action once. Future Herdr starts run the hook automatically. Manual refresh remains available.

- `start`: idempotently start the worker and refresh immediately.
- `status`: report running/waiting state, refresh count (`cycles`), and last success/error. Read the action log to see the result.
- `stop`: request shutdown; a bounded in-flight subprocess may finish, but no new metadata reports are started after stop is observed. Existing badges are left in place. Stopping is session-local; a future server startup starts polling again. Disable the plugin to prevent startup.

The worker watches the Herdr socket and checks plugin enablement periodically (about every five seconds) and before publishing. Disabling/unlinking the plugin or ending its Herdr session stops the worker. A later enable/relink requires the start action again. No Herdr server restart is needed.

Use Herdr actions for refresh/start/stop/status: they supply the config/state/socket environment. Use the `preview` action for read-only diagnostics. Each session uses separate state under `HERDR_PLUGIN_STATE_DIR`, with bounded status/error data and a token-authenticated localhost control endpoint. Kernel file locks via Bun FFI prevent duplicate workers and serialize manual/polling refreshes, and release automatically on crashes. Locks require macOS or Linux libc and Bun FFI support. A manual refresh waits up to 30 seconds for an active refresh, then fails with a busy diagnostic rather than overlapping. Crashed workers do not auto-respawn; use start or the next Herdr startup.

GitHub/authentication failures are retried after the workspace’s polling interval without clearing prior metadata. Config changes are picked up during local observation (normally every 2 seconds). Per-workspace errors do not prevent other workspaces from updating. Polling makes read-only GitHub requests for each eligible workspace; a longer interval reduces API usage.

## Formatting

Edit `config.json` under the directory printed by:

```sh
herdr plugin config-dir alx-xo.pr-status
```

Actions use `HERDR_PLUGIN_CONFIG_DIR`; manual CLI runs ask Herdr for it. No file means defaults. The file is reread every invocation and local observation. Partial settings are merged with defaults; invalid types, unknown keys and multiline labels fail before any publishing.

Example (all settings optional):

```json
{
  "pollSeconds": 60,
  "activePollSeconds": 30,
  "hideZeroThreads": true,
  "visible": {
    "pr": true,
    "pr_checks": true,
    "pr_review": true,
    "pr_threads": true
  },
  "labels": {
    "open": "",
    "draft": "WIP",
    "merged": "",
    "closed": "",
    "approved": "approved",
    "changes_requested": "changes",
    "required": "review",
    "threads": "threads",
    "unknown": "?"
  },
  "icons": {
    "draft": "D"
  }
}
```

Defaults use lifecycle icons with the PR number (e.g. ` #6401`), icon + short review text, and hide known zero threads. That example overrides draft formatting to `D #6401 WIP`. Review labels are text only; review icons are configured separately under `icons` (`approved`, `changes_requested`, `required`). Set an icon to `""` to suppress it. It changes token text, not Herdr's indentation, row placement, separators, or styles. Custom labels may no longer match your existing color rules. Emoji appearance depends on the renderer and has not been diagnosed here.

| Token | Meaning |
| --- | --- |
| `$pr` | Number and lifecycle icon: open / draft / merged / closed |
| `$pr_checks` | Passed/total checks; failure takes precedence over pending; `no checks` for known zero |
| `$pr_review` | Review decision, independent of checks and lifecycle |
| `$pr_threads` | Unresolved review-thread count, across pages; known zero hidden by default |

Check totals include GitHub status contexts and check runs; neutral/skipped runs count as passing. Unknown data displays `?`, not zero. Lifecycle never becomes “failed” because CI failed. Confirmed absent PRs and hidden fields clear the corresponding shared token keys. Unrelated token keys are untouched; another running reporter could overwrite the shared keys again.

## Icons

Nerd Font icons are built in. A Nerd Font v3.4-compatible terminal font is required; there is no icon-style selector, detection, or fallback set. Individual `icons` overrides remain available, along with text labels and visibility settings.

The built-in Octicons are: PR open `U+F407`, draft `U+F4DD`, merged `U+F419`, closed `U+F4DC`; checks passing `U+F42E`, failed `U+F467`, pending `U+F43A`; review approved `U+F49E`, changes requested `U+F440`, required `U+F4AF`.

Unknown checks/review and thread counts remain plain text. Glyph identifiers verified against [Nerd Fonts v3.4.0](https://github.com/ryanoasis/nerd-fonts/blob/v3.4.0/glyphnames.json).

Herdr sidebar rows and color rules live in Herdr's config. See the [Herdr 0.9 sidebar example](docs/sidebar.md) for copyable rows and Catppuccin Mocha colors matching the default tokens. Merge it into your existing sidebar configuration; do not replace your full config. Custom icon or label overrides may require corresponding color-rule changes. The plugin does not modify Herdr config automatically. Settings are reread on manual refresh and local observation.

## Scope and limitations

- Prefer workspace worktree paths. Otherwise normalize pane working directories to Git roots and require one unambiguous checkout. Non-Git workspaces and checkouts without remotes are skipped.
- Git branch/push-remote identity is used to verify the PR head; detached HEAD has no branch PR. For forks, this plugin searches both the fork and its parent and rejects ambiguous open matches. It prefers an open PR, otherwise the most recently updated matching terminal PR. Lists hitting the 100-result limit fail explicitly. GitHub lookup errors do not become no-PR results.
- Missing Git push refs are resolved using `push.default`; unresolved refspecs and ambiguous push destinations fail rather than guessing a PR head.
- Check counts use `gh pr checks --json state`, which paginates contexts and selects current runs rather than counting superseded attempts. Successful reruns replace older failures/cancellations; a current cancellation still counts as failed. Raw `pr list` rollups are used only to distinguish missing/empty check data, not for totals.
- Status is a snapshot: GitHub/branch changes appear on the next successful workspace refresh. A branch switch during a lookup discards that result instead of publishing it for the wrong branch. Network/authentication failures retain potentially stale metadata until a successful retry.
- No notifications, board, review pane, GitHub mutation, release pipeline, standalone binary, Node compatibility work, or marketplace publication.
- Keep settings and polling control state outside the managed or linked source checkout, in Herdr's supplied config/state directories.

## Development

For local development, clone into a permanent directory: Herdr links this
checkout, so do not move or delete it while linked.

```sh
git clone https://github.com/alx-xo/herdr-pr-status.git
cd herdr-pr-status
bun install --frozen-lockfile
herdr plugin link .
```

Linking does not run build hooks. In an existing Herdr session, explicitly invoke
`alx-xo.pr-status.start` as above. Development checks:

```sh
bun run typecheck
bun test
bun run build
bun dist/main.js info
```

Modules separate bounded subprocess execution, read-only GitHub lookup, pure formatting, Herdr discovery/publishing, and orchestration. Tests use injected command runners rather than live GitHub/Herdr writes. The optional build produces Bun-targeted JavaScript; Herdr itself invokes `bun src/main.ts` directly.

## License

[MIT](LICENSE), copyright 2026 alx-xo.
