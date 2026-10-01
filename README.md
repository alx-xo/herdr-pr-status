# herdr-pr-status

An early-stage public PR-status plugin for Herdr 0.9.0+, written in TypeScript and run directly with Bun. Requires Git and authenticated `gh`. Includes manual refresh and configurable polling. No GitHub writes, cache, or sidebar-layout changes.

![Herdr sidebar showing marketing-site PR #2306 with failing checks at 4/7 and herdr-pr-status PR #1 with passing checks at 4/4](docs/images/pr-status.png)

*Actual Herdr sidebar showing workspace branches, passing and failing PR checks, and review status.
[Optional color configuration used in this screenshot](docs/sidebar.md).*

## Requirements and installation

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

Spaces without a Git checkout or remote, and branches with no matching PR, show no
PR warning or badges. Local push destinations and known public non-GitHub providers
(GitLab.com, Bitbucket.org, Codeberg.org, and SourceHut) also stay quiet. Refresh
clears any old PR tokens in these spaces; preview reports the outcome without
writing metadata. Unknown remote hosts remain eligible for GitHub Enterprise, so
self-hosted non-GitHub providers are not automatically classified as absent.
A rebase or bisect in progress keeps showing the PR for the branch being
rebased or bisected; other detached HEADs report a warning.
Authentication, network, ambiguous-checkout, and other genuine lookup failures
still report warnings.

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

PR status refreshes automatically: every **30 seconds** for the active workspace
and **60 seconds** for background workspaces by default. Configure these with
`activePollSeconds` and `pollSeconds` (15–3600 seconds).

Use the Herdr plugin actions to `start`, `stop`, or manually `refresh`.
Use `status` or `preview` for diagnostics; results appear in the action log.

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
  "iconSet": "nerdFont",
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
| `$pr` | PR number and state icon |
| `$pr_checks` | Passed/total checks; failure takes precedence over pending; `no checks` for known zero |
| `$pr_review` | Review decision, independent of checks and lifecycle |
| `$pr_threads` | Unresolved review-thread count, across pages; known zero hidden by default |

Check totals include GitHub status contexts and check runs; neutral/skipped runs count as passing. Unknown data displays `?`, not zero. Lifecycle never becomes “failed” because CI failed. Confirmed absent PRs and hidden fields clear the corresponding shared token keys. Unrelated token keys are untouched; another running reporter could overwrite the shared keys again.

## Icons

Icons use a Nerd Font by default. If they show up blank or as boxes, set `"iconSet": "unicode"`.

| Meaning | Nerd Font | Unicode |
| --- | --- | --- |
| **PR (`$pr`)** | | |
| Open | `U+F407` | ◉ |
| Draft | `U+F4DD` | ◌ |
| Merged | `U+F419` | ↦ |
| Closed | `U+F4DC` | ⊘ |
| Has merge conflicts | `U+F47F` | ⊠ |
| In merge queue or auto-merge on | `U+F4DB` | ⋯ |
| Ready to merge | `U+F427` | ➜ |
| **Checks (`$pr_checks`)** | | |
| All passed | `U+F42E` | ✓ |
| Some failed | `U+F467` | ✗ |
| Some pending | `U+F43A` | ◔ |
| **Review (`$pr_review`)** | | |
| Approved | `U+F49E` | ✓ |
| Changes requested | `U+F440` | ∆ |
| Review required | `U+F4AF` | ⊡ |

Conflicts show over queued, and queued over ready. `⚠` means the last refresh failed; run `status` for the reason.

Override any single icon under `icons`. For sidebar colors, see [docs/sidebar.md](docs/sidebar.md).

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
