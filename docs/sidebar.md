# Herdr 0.9 sidebar

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
    { token = "$pr", fg = "#f2cdcd", rules = [{ starts_with = "\uF407", fg = "#a6e3a1" }, { starts_with = "\uF4DD", fg = "#9399b2" }, { starts_with = "\uF419", fg = "#cba6f7" }, { starts_with = "\uF4DC", fg = "#f38ba8" }] },
    { token = "$pr_checks", fg = "#f9e2af", rules = [{ starts_with = "\uF42E", fg = "#a6e3a1" }, { starts_with = "\uF467", fg = "#f38ba8" }, { equals = "checks ?", fg = "#6c7086" }, { equals = "no checks", fg = "#6c7086" }] },
    { token = "$pr_review", fg = "#f9e2af", rules = [{ starts_with = "\uF49E", fg = "#a6e3a1" }, { starts_with = "\uF440", fg = "#f38ba8" }, { equals = "review ?", fg = "#6c7086" }] },
  ],
  [
    { token = "$pr_threads", fg = "#74c7ec", rules = [{ equals = "0 threads", fg = "#6c7086" }, { equals = "? threads", fg = "#6c7086" }] },
  ],
]
```

Open/passing/approved are green; closed/failed/changes requested are red;
merged is mauve; draft is overlay2. Pending checks and required review use yellow;
unknown/no-checks/zero-thread values use overlay0; other thread counts use sapphire.
Known zero threads are hidden by default, so that rule matters only when
`hideZeroThreads` is false. Absent PRs clear all four tokens. Change these matchers
if you customize icons or labels. The plugin only publishes tokens: it does not
install these rows or modify your Herdr configuration.
