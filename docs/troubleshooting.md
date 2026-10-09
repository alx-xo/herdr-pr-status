# Troubleshooting and lookup behavior

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
