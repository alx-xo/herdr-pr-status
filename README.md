# herdr-pr-status

An early-stage public PR-status plugin for Herdr 0.9.0+, written in TypeScript and run directly with Bun. Requires Git and authenticated `gh`. Includes manual refresh and configurable polling. No GitHub writes, cache, or sidebar-layout changes.

## Requirements and installation

Tested toolchain: Herdr **0.9.x** (locally verified CLI: 0.9.1), Bun **1.4.2**,
GitHub CLI (`gh`) **2.101.0**, and Git **2.54.0**. macOS and Linux are supported;
CI checks both. Use a **Nerd Font v3.4-compatible** terminal font for the default icons.
Authenticate `gh` for the repositories you want to read before using the plugin.

Clone into a permanent directory (Herdr links this checkout; do not delete or move it):

```sh
git clone https://github.com/alx-xo/herdr-pr-status.git
cd herdr-pr-status
bun install --frozen-lockfile
herdr plugin link .
```

Then, from a terminal inside your running Herdr session:

```sh
herdr plugin action invoke alx-xo.pr-status.start
```

The link command registers the plugin; the start action publishes workspace tokens
and begins polling. These are installation instructions, not commands run during
repository validation. For read-only diagnostics inside Herdr:

```sh
bun src/main.ts info
bun src/main.ts preview  # read GitHub, print tokens; no metadata writes
```

This is a source-linked plugin, not an npm package (`private: true` is intentional).

Herdr actions (after `herdr plugin link .`):

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

## Polling

The polling interval is `pollSeconds` in the plugin config: **60 seconds by default**, an integer from **15 to 3600**. The worker refreshes immediately on startup, then waits the configured interval after each cycle completes. Refresh duration adds to that interval; cycles never overlap. There is no instantaneous branch-change subscription.

Polling uses a one-shot Herdr startup hook to launch a session-scoped worker. Linking or enabling a plugin does not run startup hooks, so an already-running Herdr session needs the start action once. Future Herdr starts run the hook automatically. Manual refresh remains available.

- `start`: idempotently start the worker and refresh immediately.
- `status`: report running/waiting state, completed cycles, last success/error and next scheduled cycle. Read the action log to see the result.
- `stop`: request shutdown; a bounded in-flight subprocess may finish, but no new metadata reports are started after stop is observed. Existing badges are left in place. Stopping is session-local; a future server startup starts polling again. Disable the plugin to prevent startup.

The worker watches the Herdr socket and checks plugin enablement periodically (about every five seconds) and before publishing. Disabling/unlinking the plugin or ending its Herdr session stops the worker. A later enable/relink requires the start action again. No Herdr server restart is needed.

Use Herdr actions for refresh/start/stop/status: they supply the config/state/socket environment. Plain `bun src/main.ts preview` remains available inside Herdr for read-only diagnostics. Each session uses separate state under `HERDR_PLUGIN_STATE_DIR`, with bounded status/error data and a token-authenticated localhost control endpoint. Kernel file locks via Bun FFI prevent duplicate workers and serialize manual/polling refreshes, and release automatically on crashes. Locks require macOS or Linux libc and Bun FFI support. A manual refresh waits up to 30 seconds for an active cycle, then fails with a busy diagnostic rather than overlapping. Crashed workers do not auto-respawn; use start or the next Herdr startup.

GitHub/authentication failures are retried on a later cycle without clearing prior metadata. Config changes are picked up on the next cycle. Per-workspace errors do not prevent other workspaces from updating. Polling makes read-only GitHub requests for each eligible workspace; a longer interval reduces API usage.

## Formatting

Edit `config.json` under the directory printed by:

```sh
herdr plugin config-dir alx-xo.pr-status
```

Actions use `HERDR_PLUGIN_CONFIG_DIR`; manual CLI runs ask Herdr for it. No file means defaults. The file is reread every invocation and polling cycle. Partial settings are merged with defaults; invalid types, unknown keys and multiline labels fail before any publishing.

Example (all settings optional):

```json
{
  "pollSeconds": 60,
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

Herdr sidebar rows and color rules live in Herdr's config. See the [Herdr 0.9 sidebar example](docs/sidebar.md) for copyable rows and Catppuccin Mocha colors matching the default tokens. Merge it into your existing sidebar configuration; do not replace your full config. Custom icon or label overrides may require corresponding color-rule changes. The plugin does not modify Herdr config automatically. Settings are reread on manual refresh and polling cycles.

## Scope and limitations

- Prefer workspace worktree paths. Otherwise normalize pane working directories to Git roots and require one unambiguous checkout. Non-Git workspaces and checkouts without remotes are skipped.
- Git branch/push-remote identity is used to verify the PR head; detached HEAD has no branch PR. For forks, this plugin searches both the fork and its parent and rejects ambiguous open matches. It prefers an open PR, otherwise the most recently updated matching terminal PR. Lists hitting the 100-result limit fail explicitly. GitHub lookup errors do not become no-PR results.
- Missing Git push refs are resolved using `push.default`; unresolved refspecs and ambiguous push destinations fail rather than guessing a PR head.
- Check counts use `gh pr checks --json state`, which paginates contexts and selects current runs rather than counting superseded attempts. Successful reruns replace older failures/cancellations; a current cancellation still counts as failed. Raw `pr list` rollups are used only to distinguish missing/empty check data, not for totals.
- Status is a snapshot: GitHub/branch changes appear on the next successful polling cycle or manual refresh. A branch switch during a lookup discards that result instead of publishing it for the wrong branch. Network/authentication failures retain potentially stale metadata until a successful retry.
- No notifications, board, review pane, GitHub mutation, release pipeline, standalone binary, Node compatibility work, or marketplace publication.
- Keep settings and polling control state outside the linked source checkout, in Herdr's supplied config/state directories.

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
bun dist/main.js info
```

Modules separate bounded subprocess execution, read-only GitHub lookup, pure formatting, Herdr discovery/publishing, and orchestration. Tests use injected command runners rather than live GitHub/Herdr writes. The optional build produces Bun-targeted JavaScript; Herdr itself invokes `bun src/main.ts` directly.

## License

[MIT](LICENSE), copyright 2026 alx-xo.
