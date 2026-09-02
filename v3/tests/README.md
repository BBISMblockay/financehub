# `/v3/tests/` — tests for the dashboard runtime

```bash
node v3/tests/run.js --unit      # needs nothing installed
node v3/tests/run.js             # everything
node v3/tests/run.js slicers     # one suite, by filename
```

Browser suites need dependencies once:

```bash
cd v3/tests && npm install && npx playwright install chromium
```

Without them the runner **skips** the browser suites and says so, rather than
failing. That split is deliberate: a clean checkout can still run the unit
suites, and a test nobody can run without a working `npm install` is a test
nobody runs.

## What is here

| | |
|---|---|
| `unit/` | Pure logic, no browser. SQL composition, parameter substitution, semantics, chart shaping |
| `browser/` | Real pages in real Chromium against a stubbed Supabase |
| `browser/fixtures/` | The fake Supabase client and config the pages load instead of the real ones |
| `lib/` | Shared loader, harness and assertions |
| `run.js` | Runner — spawns each suite as its own process |

## Unit suites

| Suite | Covers |
|---|---|
| `report-params` | **The security surface.** Typed substitution, and the injection attempt each type must refuse |
| `calculated-measures` | Ratios/percent-of/differences, semantic declaration, and schema-probe detection |
| `report-builder-sql` | Guided SQL composition, identifier quoting, forced matview scoping |
| `report-parameters-sql` | `{{token}}` passthrough in guided filters, declaration validation |
| `chart-adapter` | Column profiling, visual recommendation, grouping/sorting/limiting, formatting |

`lib/load.js` evaluates `v3/js/*.js` in a node VM. Those files are IIFEs that
hang objects off `window` — not a module format, deliberately, since the pages
are served statically with no build step. So they cannot be `require`d; they
have to be evaluated against a stand-in global. If a new module needs another
stub at load time, add it in `load.js` so every suite sees one environment.

## Browser suites

| Suite | Covers |
|---|---|
| `dashboard` | The V1 milestone: add a report, switch Table/Bar/Line/Donut/KPI, drag/resize, save, **reload identically**. Plus mobile collapse |
| `slicers` | Parameters end to end, and that a bad value never reaches the RPC |
| `report-builder` | The workbench: source picking, summarise, filters, preview, save |
| `ask-silo-hop` | Save an answer as a report and land on a canvas with it added |
| `dashboards-list` | The index, and a missing id explaining itself |

**The pages are served unmodified from the repo.** The real `dashboard.html`
runs the real `dashboard-renderer.js`; only the outside world is faked. If a
suite passes, that code path works.

`lib/harness.js` starts a static server over the repo, launches Chromium, and
stubs six routes — config, the Supabase client, ECharts, GridStack, and Google
Fonts. That setup used to be copy-pasted across five files, which is how the
hardcoded Chromium path in each would have gone stale one at a time.

### Assert on what reached the RPC, not just on pixels

`fixtures/fake-supabase.js` records every call in `window.__FAKE_DB__.rpcCalls`.
The strongest assertions in these suites read that array — "the resolved SQL
carried `date '2026-09-01'`", "an invalid number produced **zero** RPC calls" —
rather than checking that a tile looks right. A tile can look right and be
running the wrong query.

### Versions are pinned, not caret-ranged

`echarts` and `gridstack` in `package.json` are pinned to the exact versions
`v3/*.html` loads from the CDN. A test passing against a different ECharts than
production runs is worse than no test.

### Chromium resolution

`chromiumPath()` tries, in order: `PLAYWRIGHT_CHROMIUM_PATH`, the sandbox's
stable symlink at `/opt/pw-browsers/chromium`, then Playwright's own
resolution. It has to work both in a sandbox with a pre-installed browser at a
pinned build number and in CI after `npx playwright install chromium`.

## Adding a test

Drop a `*.test.js` into `unit/` or `browser/`; the runner finds it. Exit
non-zero on failure — that is the whole contract, which is why each suite can
also be run directly while you debug it:

```bash
node v3/tests/browser/slicers.test.js
V3_TEST_SCREENSHOTS=1 node v3/tests/browser/report-builder.test.js
```

## CI

`.github/workflows/v3-tests.yml` runs everything on any push or PR touching
`v3/`. It needs no secrets — nothing here talks to a real database.
