# Configuration reference

All settings are optional. Without a configuration file, the plugin uses defaults.

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

Defaults use lifecycle icons with the PR number (e.g. ` #6401`), icon + short review text, and hide known zero threads. That example overrides draft formatting to `D #6401 WIP`. Review labels are text only; review icons are configured separately under `icons` (`approved`, `changes_requested`, `required`). Set an icon to `""` to suppress it. It changes token text, not Herdr's indentation, row placement, separators, or styles. Custom labels may no longer match your existing color rules.

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

Conflicts show over queued, and queued over ready. `⚠` means the last refresh failed; use the `status` action for the reason (see [troubleshooting](troubleshooting.md)).

Override any single icon under `icons`. For sidebar colors, see [sidebar colors](sidebar.md).
