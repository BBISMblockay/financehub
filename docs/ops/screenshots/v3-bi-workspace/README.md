# v3 BI workspace — before / after (2026-09-08)

Screenshots for the BI workspace upgrade PR. Kept in the repo so the PR is
readable a year from now, when the branch that produced it is gone.

Both sides show the **same board** — a section, two KPIs, a bar chart, a
second section and a table — rendered by the real pages against the test
suite's stubbed Supabase. No real company data is in any of them.

| File | What it shows |
|---|---|
| `before-desktop.png` | origin/main. The description runs inline after the title; the sidebar has no Reports entry; a table offers no search, sort or export; a tile offers no full screen. |
| `after-desktop.png` | The same board. Compact header with the description behind ⓘ, filter bar with applied-value chips, tile actions, a heatmap and a waterfall, a table with search and CSV. |
| `after-desktop-compact.png` | The same board at compact density. Same 12 columns, same `{x,y,w,h}` — only the row height and gutter change. |
| `before-editor.png` | origin/main's inspector: one scroll of nineteen controls. Note the **header title wrapping onto two lines** with the description beside it — the reported bug. |
| `after-editor.png` | Data \| Visual \| Format \| Interactions, with the edited tile ringed as the live preview. |
| `after-tablet.png` | 900px. Still the 12-column arrangement. |
| `before-phone.png` / `after-phone.png` | 390px. The grid collapses to one column in both; after, the stack reads in the desktop's order (before, each row was inverted — see the PR). |

## Regenerating

```bash
cd v3/tests && npm install && npx playwright install chromium
V3_TEST_SCREENSHOTS=1 V3_SHOT_DIR=/some/dir node v3/tests/browser/responsive.test.js
```

The "before" images came from a `git worktree` at `origin/main` running its
own copy of the harness, seeded with reports that exist in that revision's
fixture. There is no script for that in the repo: it would have to be
rewritten against whatever "before" meant at the time, which is the sort of
thing that rots quietly.
