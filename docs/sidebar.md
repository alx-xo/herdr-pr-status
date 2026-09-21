# Optional sidebar colors

These optional Catppuccin Mocha colors match the configuration used in the README
screenshot. They are Herdr settings, not plugin defaults or plugin `config.json`
settings. You can use the plugin without these color overrides.

Merge these rows into `ui.sidebar.spaces` in your Herdr `config.toml`.
**Do not replace your full configuration.** If `[ui.sidebar.spaces]` already exists,
edit its existing `rows` array rather than adding a duplicate table or `rows` key.
Preserve any other workspace rows, settings, and unrelated plugin tokens you use.
The first two rows below are a basic workspace/branch layout; append the final two
PR rows to your own layout if you already have one.

This uses Herdr 0.9's row arrays and token objects (`token`, `fg`, `rules`),
with `starts_with`/`equals` matchers. Colors are Catppuccin Mocha and match the
plugin's default Nerd Font icons and labels. TOML Unicode escapes keep the icon
matchers copyable even when the viewing font lacks the glyphs.

```toml
[ui.sidebar.spaces]
row_gap = 1
rows = [
  ["state_icon", "workspace"],
  ["branch", "git_status"],
  [
    { token = "$pr", fg = "#f2cdcd" },
    { token = "$pr_checks", fg = "#f9e2af", rules = [
      { starts_with = "\uF42E", fg = "#a6e3a1" },
      { starts_with = "\uF467", fg = "#f38ba8" },
    ] },
    { token = "$pr_review", fg = "#f9e2af", rules = [
      { starts_with = "\uF49E", fg = "#a6e3a1" },
      { starts_with = "\uF440", fg = "#f38ba8" },
      { equals = "review ?", fg = "#6c7086" },
    ] },
  ],
  [
    { token = "$pr_threads", fg = "#74c7ec", rules = [
      { equals = "0 threads", fg = "#6c7086" },
    ] },
  ],
]
```

PR icons and numbers stay flamingo (`#f2cdcd`) for every lifecycle state.
Passing checks and approved reviews are green; failed checks and changes requested
are red. Other check/review values use yellow, except unknown review status, which
is muted. Thread counts use sapphire, with a muted rule for visible zero counts.
Known zero threads are hidden by default, so that rule matters only when
`hideZeroThreads` is false. Absent PRs clear all four tokens. Change these matchers
if you customize icons or labels. The plugin only publishes tokens: it does not
install these rows or modify your Herdr configuration.
