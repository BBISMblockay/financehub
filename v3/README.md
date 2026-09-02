# `/v3/` — the dashboard runtime

This folder is not a rewrite of SILO and not a second app. It is one feature
that needed its own directory: a **visualization runtime** that renders saved
configuration. Pages here load the v2 Beacon shell (`../v2/beacon.css`,
`nav-config.js`, `silo-chrome.js`) exactly like a v2 Pattern 1 page, and they
read `window.__SILO_CONFIG__` and talk to Supabase the same way.

## The idea in one line

A dashboard is **not stored as HTML**. It is stored as rows:

```
saved Ask SILO report  →  which of its queries  →  which visual  →  where on the grid
silo_chat_saved_reports    dashboard_widgets.query_index    .visual_type/.visual_config    .layout
```

Switching a tile from a table to a bar chart is a one-field update and a
re-render. It is not a new page, not an LLM call, and not a deploy.

## What the workbench offers, and why it is not everything

Two catalog columns curate `/v3/report-builder.html`, and **neither touches
Ask SILO** — it filters on `is_hidden`, which is a different question
("keep this out of the model's index"). Ask SILO still sees all 189 objects,
including payroll, AR and comp, because it is legitimately asked about them.

| Column | Meaning | Default |
|---|---|---|
| `reportable` | Offer it in the rail at all | **false** — an allowlist |
| `report_priority` | `1` = "Start here" | `0` — still listed, just below |

`reportable` defaults to **false** on purpose. A denylist means the next
finance table someone adds appears in the workbench on its own and nobody
notices until it is on a dashboard; an allowlist makes the failure mode "a
useful table is missing", which someone reports. 74 objects are offered:
sales, Shopify order/session/funnel detail, marketing paid and organic,
product, inventory, launches, purchasing and landed cost, returns.

`report_priority` is soft — it orders the shelf, it does not lock a cupboard.
The 20 starred sources are the ones whose own curated descriptions say to
prefer them ("the grain buying decisions are made at", "Use this rather than
raw sales_by_day"), because an analyst opening on eight interchangeable-
looking sales rollups cannot choose between them.

**Both are curation, not a boundary.** RLS is still the boundary. The SQL tab
can name any object, and someone who types `comp_adjustment_requests` gets
exactly the rows their policies allow — for most people, none.

Plumbing columns (`id`, `company_entity_id`, `row_hash`, `synced_at`, uuid
foreign keys) are hidden in the build pane behind a "show all" toggle, and
the business columns are pre-selected rather than emitting `select *` — the
point of hiding them is that the *preview* stops being full of ids.

## Three authoring surfaces, one engine

| Surface | Writes | Where |
|---|---|---|
| Ask SILO | `source = 'ask_silo'` | `/v2/silo-chat.html` — Save report |
| Report builder | `source = 'manual'` | `/v3/report-builder.html` |
| Migrations | `source = 'system'` | seeded, global |

The report builder has two tabs over one preview. **Build** picks a table or
view from `silo_chat_schema_catalog` (which already exists to feed Ask SILO
and works just as well as a picker), then columns, group-and-total, a date
window, filters, sort and limit. **SQL** is a plain editor with the same
schema browser. Both compose one `SELECT`, both run through
`chat_run_readonly_query`, and neither can save without previewing first — a
report nobody has run is how a broken tile gets shared.

**The one rule the database cannot enforce for us:** Postgres does not apply
RLS to materialized views. So the Build tab force-adds
`company_entity_id = active_company_id()` to any matview source and says so;
the SQL tab cannot force anything, so it warns instead when it sees a matview
referenced without a company predicate.

Column semantics come from the catalog's real pg types at save time, so a
hand-built report is grounded from birth rather than guessed at.

## Where a report comes from

The renderer does not know and must not care. A widget points at a row in
`silo_chat_saved_reports` — **the generic saved-report layer, despite the
name** — and that row's `source` says which authoring surface produced it:

| `source` | What it is | Scope |
|---|---|---|
| `ask_silo` | An answer pinned from chat | Company |
| `manual` | Hand-defined by a person | Company |
| `system` | A central SILO definition (Daily Sales, Open POs…) | **Global** — `company_entity_id IS NULL`, one row reused by every tenant |

A global definition is safe because its SQL runs through
`chat_run_readonly_query` under the *caller's* RLS: one definition scopes
itself per tenant. NULL company is therefore privileged, and clients are
locked out of it three independent ways — a table CHECK, an INSERT policy
requiring a non-null company and `source in ('ask_silo','manual')`, and an
UPDATE policy whose USING is false for global rows. System definitions are
writable only by service role / migrations.

The picker lists every source. Ask SILO's own saved-reports modal filters to
`source = 'ask_silo'`, because that modal means "answers you pinned", not
"every report that exists".

## Why there is no new `saved_reports` table

SILO already has one. `silo_chat_saved_reports` (migration `20260818050000`)
stores a question, the answer, and the exact SQL (`queries_run`) that produced
it, and Ask SILO's "Refresh data" button already re-runs that SQL client-side
through `chat_run_readonly_query`. A widget is just *that report + which query
+ how to draw it*. A parallel table would have forked the one artifact Ask SILO
produces and split refresh behaviour across two code paths.

`chat_run_readonly_query` is `SECURITY INVOKER`, so every widget query is
scoped by the viewer's own RLS. **A dashboard can never show someone data they
could not already query themselves.** It also caps results at 500 rows and
statements at 30s — both surface in the UI rather than being silently absorbed.

## What a column means

The renderer has to know whether `19362` is dollars, units, or a percentage.
The first build guessed from the column name and got `total_units` wrong
(currency — "total" is a money word). Decoupling the dataset from the visual
is what makes that class of bug possible at all: once one report can be drawn
five ways, nothing in the drawing code knows what the values mean.

`field-semantics.js` resolves it from four sources, most authoritative first:

| Layer | Source | Notes |
|---|---|---|
| 1 | `visual_config.field_semantics` | Per-widget override |
| 2 | `silo_chat_saved_reports.columns_metadata` | **Belongs to the report**, so one correction fixes every widget on it |
| 3 | `silo_chat_schema_catalog` | Grounded, not guessed: Postgres already knows `units` is `integer` and `net_sales` is `numeric` |
| 4 | Value profiling + name heuristics | The old behaviour, now last |

Layer 3 does the real work today and fixes `total_units` at the root — an
integer column is a count, whatever its name says. Layer 2 is how it gets
reliable: v3 seeds it from 1+3+4 the first time a widget is built on a report,
a human corrects it in the inspector, and Ask SILO can write it at save time
later. Only *grounded* answers are seeded — writing a name guess into
`columns_metadata` would launder a guess into an authoritative record.

Semantics decide two things: how a value is printed, and which aggregation
makes sense. Sum is right for currency and counts and wrong for rates
(40%/50%/60% averages to 50%, sums to 150%), so `percent` defaults to `avg`.

## Seeded system reports

`20260828150000_seed_system_reports.sql` ships four `source = 'system'`
definitions — Daily Sales, Top Products (30d), Sales by Location (30d), Open
Purchase Orders — so a dashboard has something to build on before anyone has
saved an Ask SILO report, and so the four visuals each have a natural example.
They carry their own `columns_metadata`, so they format correctly on first
render without waiting on the schema catalog.

**The rule to keep when adding more:** every definition reads a
`security_invoker` view or an RLS-enabled base table, **never a materialized
view**. Postgres does not enforce RLS on matviews — `sales_velocity_by_sku_location_mv`,
`inventory_on_hand_current_mv` and `sales_monthly_product_type_rollup_mv` all
carry `company_entity_id` but none can filter on it by policy, so a *global*
definition querying one would return every tenant's rows to every tenant. If a
future one genuinely needs a matview for speed, it must carry an explicit
`where company_entity_id = active_company_id()`. `inventory_workboard_v` is
avoided too, for a duller reason: it already exceeds the 30s statement timeout.

Idempotent via fixed UUIDs and `on conflict (id) do nothing` — deliberately not
`do update`, since `apply_all_post_merge.sql` is re-run for rebuilds and a
do-update would discard anyone's correction. Changing a shipped definition is
its own migration.

## Bump the asset version when you change these files

Every `v3` script and stylesheet is loaded with `?v=<version>`. The site is
served statically with no build step, so a browser that cached
`dashboard-builder.js` keeps running it after a deploy — and the symptom is a
half-updated page, not an error. It cost a real debugging round: an inspector
showing the previous release's single-measure dropdown while the rest of the
same page was current.

**Changing anything in `v3/js/` or `dashboard.css` means bumping the version
in all three `v3/*.html` files.** One find-and-replace. If you skip it, the
change ships and nobody sees it until they hard-refresh.

## Files

| File | Role |
|------|------|
| `dashboards.html` | List / create dashboards |
| `dashboard.html` | The canvas. `?id=<uuid>` to view, `&edit=1` to edit |
| `dashboard.css` | Tile chrome, inspector, picker. Beacon tokens only — no new CSS variables |
| `js/report-params.js` | Turns a report's declared parameters plus a dashboard's slicer values into runnable SQL. The **only** place a UI value becomes part of a query — every literal is produced by type, never concatenated. No DOM, no ECharts, pure and unit-tested |
| `js/field-semantics.js` | What a column *means* (currency / count / percent / date / category), resolved from four layers. No ECharts, no DOM |
| `js/chart-adapter.js` | The only file that talks to ECharts. Profiles rows, recommends a visual, groups/sorts/limits, builds options, renders table/KPI HTML |
| `js/dashboard-renderer.js` | Owns the GridStack instance and draws widgets from config. Used unchanged in view **and** edit mode |
| `js/dashboard-builder.js` | Edit mode only: report picker, inspector, buffered save |
| `report-builder.html`, `js/report-builder.js`, `js/report-builder-ui.js` | The workbench: build a report from a table/view or write SQL, declare parameters, preview, save. Composition and every safety rule live in `report-builder.js`, which is pure and unit-tested; the `-ui` file only turns clicks into config |

Libraries are CDN-loaded and version-pinned: GridStack 10.3.1 (canvas
interactions) and ECharts 5.5.1 (charts).

## Tables

`dashboards` and `dashboard_widgets` (migration `20260828120000_v3_dashboards.sql`),
plus the `dashboards_v` / `dashboard_widgets_v` `security_invoker` views. RLS
follows the existing company-membership model; widget access is entirely
inherited from the parent dashboard via an `EXISTS`.

`silo_chat_saved_reports.parameters` and `dashboards.filter_state`
(`20260903100000_report_parameters.sql`) carry slicers — see below.

## Decisions worth knowing before changing this

- **`query_index` exists because `queries_run` is an array.** A saved answer
  often ran several queries; a widget draws exactly one. The picker asks which
  when there is a choice rather than silently taking the first.
- **Editing is buffered, not live.** Add / configure / remove change local
  state; one Save writes the set. Widget ids are minted client-side so that set
  goes back as a single idempotent upsert — re-saving after a failure does not
  duplicate tiles.
- **Grouping happens before sort and limit**, which is the only order that
  answers the question asked: taking the top 10 rows and then summing per
  product is a different (wrong) answer from summing per product and then
  taking the top 10. The tile's footer says when a roll-up happened, because
  grouping is otherwise invisible.
- **Geometry is read from each item's live `gridstackNode`, never from
  `grid.save()`.** `save()` omits a property matching the item's min or
  default, so a tile at `h=2` with `gs-min-h=2` came back with no `h` at all
  and reloaded at the default height — quietly breaking reload-identically
  for every KPI.
- **Below 700px the grid collapses to one column**, and `layout()` refuses to
  serialise a collapsed grid — saving from a phone would otherwise overwrite
  the real 12-column layout with the phone's, for everyone.
- **Sort / limit are applied to returned rows, not pushed into SQL.** The widget
  does not rewrite its report's query, and the UI says so. A tile whose query
  hit the 500-row cap says that too — a silently truncated chart is a quiet lie.
- **`recommend()` prefers bar over donut.** Few rows is not evidence of a
  composition: a top-4-products query has few rows and is a *ranking*. Donut is
  suggested only when the dimension's name says composition (channel, location,
  type, …). Bar is never actively misleading, only sometimes less expressive.
- **Currency inference checks count-words first.** `total_units` is a count, not
  dollars; `net_sales` is dollars. Formatting a unit count as currency is a
  wrong number on a dashboard, not a cosmetic slip.
- **Palette is explicit hex, not the beacon `oklch()` tokens.** ECharts/zrender
  parses colours to derive hover shades and its parser predates `oklch()`, so a
  token read off `:root` comes back null and hover states render transparent.
- **Watch the `[hidden]` trap.** Any class here that sets `display` needs an
  explicit `[hidden] { display: none }` rule — the UA rule loses to an
  author-stylesheet class of equal specificity. `beacon.css` documents the same
  trap for `.bcn-btn`; `.v3-blank` and `.v3-meta-bar` both hit it during build.

## Charts with more than one measure

`visual_config.measures` is an array of column names; `y_field` is the
single-measure form every widget built before it used, and still works
untouched — `points[].value` stays the first measure so KPI, donut and the
table path are unaffected.

Two rules make a multi-measure chart honest:

- **A measure gets its own right-hand axis** when it means something
  different from the first one, or when its typical magnitude is more than
  25× away. ROAS averages 3.3 next to $38,000 of sales; on one axis it is a
  flat line on the floor. A secondary-axis measure is drawn as a *line* even
  in a bar chart — a ratio rendered as a bar beside dollar bars invites
  reading them as comparable heights.
- **Each measure is aggregated by its own semantic**, not the widget's.
  Summing a ratio alongside summing dollars is how a ROAS column becomes 99
  instead of 3.3.

The acceptance case is one flat query — `day_date, online_net_sales,
ad_spend, roas`, one row per day — plotted as three series on two axes.

## The matrix visual

Every other visual reduces a result to one dimension and one measure. A
financial statement is not that shape: a P&L is **lines down, months
across**, and rendered long it is 160 correct rows that read as nothing.
Same for sales by category by month, or units by size by location.

```
row_field   the dimension down the side
x_field     the dimension across the top
y_field     the measure in the cells
aggregate   how to combine when a (row, column) pair has several source rows
```

Two rules worth keeping:

**Row and column order come from the QUERY**, in order of first appearance,
not sorted. That is the whole reason a P&L comes out right — Income, COGS,
Gross Profit, Expenses, Net Income is a meaningful sequence that
alphabetical order destroys, and the report's own `ORDER BY` already put
them in it. Dates are the one exception; a month column reads
chronologically whatever order it arrived in.

**An absent cell is empty, never zero.** "No row for August" and "August was
zero" are different facts, and printing `0` for both is the same class of
lie as a coalesced velocity.

### One CSS trap, recorded because it cost four attempts

Beacon declares `table.bcn-table { table-layout: fixed }` — **element +
class**, which outranks a bare `.dw-matrix` rule. The matrix carries both
classes, so every one-class override silently lost and the table kept fixed
layout, which divides width equally across all columns and ignores content:
20 months got ~60px each and the row labels painted straight over January.
The fix is `table.dw-matrix`, matching the specificity. Anything overriding
a Beacon table needs the element selector too.

## Link and image cells

Two semantics that say how to DRAW a cell rather than how to measure it, so
neither is a measure and neither is offered as a dimension (grouping by URL
is meaningless):

| Semantic | Renders as |
|---|---|
| `link` | An anchor labelled `host/last-path-segment`, full URL on `title`, `target="_blank" rel="noopener noreferrer"` |
| `image` | A 44px-tall lazy-loaded thumbnail, itself linked to the full image |

**Detected from the VALUES, not the name.** A column whose every non-null
value is an `http(s)` URL is a link; a column *named* `link` might hold
anything. An image is a URL column that either looks like one (`.png`,
`.jpg`, …) or is named like one (`image`, `thumb`, `creative`, …).

**These are the only cells that put a database value into an HTML attribute**
rather than a text node, so both go through one guard: `^https?://` with no
whitespace. That rejects `javascript:`, `data:`, `vbscript:`, `file:` and
protocol-relative `//evil.com` (which silently inherits the page's scheme).
A value that fails renders as ordinary escaped text — visible, but inert.
`v3/tests/unit/link-image-cells.test.js` asserts each of those cases can
reach neither an `href` nor a `src`.

Image height is capped rather than width, because ad creatives arrive in
wildly different aspect ratios and a width cap makes a tall one enormous.

## Publishing a board publishes its reports

A **company** dashboard whose reports are **private** renders blank tiles for
everyone else — `dashboard_widgets_v` is `security_invoker`, so a report the
viewer cannot see yields a null `query_sql`. Sharing the arrangement is not
sharing the data, and a board was shared exactly once before this was true,
landing the recipient on nine empty tiles.

So saving a board as company-visible promotes its private reports too — and
says how many, because this widens who can read them. Only reports the saver
is allowed to update move (the RLS policy is creator-or-exec); someone else's
private report stays private and the message says those tiles will still be
blank for everyone but their owner.

## Calculated measures

A measure over two aggregates rather than one. ROAS is `sum(sales) /
sum(spend)` and no column anywhere holds it; without this, an analyst who
wants a rate has to leave for the SQL tab, which is the moment the guided
builder stops being self-serve.

| Calculation | SQL | Produces |
|---|---|---|
| A ÷ B | `round((sum(a) / nullif(sum(b), 0))::numeric, 4)` | `number` |
| A as % of B | `round((sum(a) / nullif(sum(b), 0) * 100)::numeric, 2)` | `percent` |
| A − B | `(sum(a) - sum(b))` | inherits A's meaning |

Two rules that are load-bearing:

**Every division goes through `nullif(x, 0)`.** A zero denominator is
ordinary in real data — a platform with clicks and no spend, a day with no
orders — and it has to produce an empty cell, not a failed query that takes
the whole tile down.

**The calculation declares its own semantic.** This is where the four-layer
typing would otherwise fall through: a calculated column exists in no
catalog, so the grounded layer that stops `total_units` printing as currency
has nothing to say about it, and name heuristics get
`net_sales_pct_of_total` wrong — "sales" reads as money, so 12.4% would
print as $12.40. `metadataForMeasures()` stamps it at save time and it
overlays `metadataFromCatalog()`.

Half a calculation is **dropped**, never emitted as its left half. A measure
showing `sum(sales)` where someone asked for `sales / spend` looks like it
works and is wrong, which is the worst of the three outcomes.

## Which query of a saved answer to draw

An Ask SILO answer's `queries_run` is a **transcript, not a dataset list**.
The first entry is very often `select column_name from information_schema…`
— the model orienting itself before it can write the real query. A widget
defaulting to index 0 then renders a list of column names, and it looks like
a working tile because it has rows and headers.

That is not hypothetical: "Open payment requests by vendor" shipped onto a
dashboard twice showing exactly that, with the real query at index 1.

So `defaultQueryIndex()` picks the **last non-probe** query — in a tool loop
the closing query is the answer and the earlier ones are the model working
up to it — and the picker badges probes as "schema lookup — not an answer".
Dimmed, not hidden: they stay previewable, and hiding one would make the
numbering lie about the transcript.

## Parameters and slicers

A report declares what it needs; the dashboard supplies it; the runner
substitutes before executing.

```
report.parameters      [{ key, type, label, default, options? }]
dashboard.filter_state { "grain": "week", "report_date": "today" }
report SQL             select * from wow_kpi_compare({{report_date}}, {{grain}})
```

Matching is **by key across reports**, which is the whole point: nine reports
that each declare `report_date` get one control in the header, not nine.
Changing it re-runs only the widgets whose SQL actually reads that key.

**Substitution is typed, never string interpolation.**
`chat_run_readonly_query` is SECURITY INVOKER, so nothing pushed through a
parameter can read another company's rows — RLS still decides that. But it
could rewrite the report into a question nobody asked, and "the blast radius
is small" is a bad reason to build an injection point. A value never reaches
the SQL as text; it is converted to a literal by type:

| Type | Becomes | Rejected if |
|---|---|---|
| `number` | digits, via `Number()` + `isFinite` | not a number — a string that isn't one cannot survive the conversion |
| `date` | `date 'YYYY-MM-DD'` | not a real calendar date, or a relative token outside the small set below |
| `enum` | a quoted string | not `===` one of the **declared** options. Compared, not sanitised |
| `text` | a quoted string, quotes doubled | it carries a control character or a semicolon |

A `{{token}}` the report does not declare is an **error**, never a
passthrough and never left in place: the declaration is the allowlist. The
report builder blocks saving on one; the tile says so rather than running.

Relative date values are deliberately few — `today`, `today-Nd`,
`month_start`, `year_start`, or a literal date. A date slicer stores the
**token**, not the date it resolves to today: storing the resolved date would
freeze a "last 28 days" board on the day it was saved. The concrete date is
shown under the control so nobody has to work it out.

Why literals and not bind parameters, which would be stronger in general:
`chat_run_readonly_query` takes one `text` argument and `EXECUTE`s it,
because it exists to run SQL nobody wrote in advance. Given that shape, the
honest design is to make the set of things a parameter can become small and
typed, and an undeclared token fatal.

**Who a change belongs to.** Slicers are present in view mode — changing the
date range is the ordinary way to read a dashboard, not an edit. A viewer's
change applies to their session and nobody else's; only an editor's **Save**
writes `filter_state` back as the dashboard's saved position.

The Week over Week dashboard is the worked example: nine reports sharing
`{{grain}}` (day/week/month/ytd) and `{{report_date}}`. Its `report_date` is
wrapped in `least(..., complete_through)` so the slicer can only move the
window *backward* from the last complete day — the useful direction, and it
keeps the property the board was built with: never report a partial day.
Its column aliases were renamed off the grain at the same time (`this_week` →
`current_period`, `wow_pct` → `change_pct`), because at day grain a column
headed "this_week" showing one day is a wrong label, not a cosmetic slip.

## Getting a report onto a dashboard

Two doors, both landing in the same place:

1. **From Ask SILO** — the save dialog offers "Add to a dashboard" (existing
   ones you can edit, or a new one). Saving hands off to
   `/v3/dashboard.html?id=…&edit=1&add_report=…`, and the dashboard page adds
   the widget, recommends a visual and saves. The report is written *before*
   the hand-off, so a failure past that point degrades to "saved, not added"
   and never loses work.
2. **From the dashboard** — "+ Add widget" opens the picker over every saved
   report, whatever its source.

The hand-off is a redirect rather than v2 building the widget itself, on
purpose: the dashboard page owns profiling and recommendation, and it should
stay the only place that does. A v2 page importing `/v3/` code would invert
the dependency and leave two recommendation paths to keep in step.
`add_report` is stripped from the URL on arrival, so a refresh cannot add the
same report twice.

## Deliberately not built yet

Named here so nobody reads their absence as an oversight:

- **Per-widget parameter overrides.** Slicers are dashboard-level only: one
  value per key, applied to every widget declaring it. A tile quietly on a
  different date range than the header claims makes "what am I looking at"
  unanswerable, which defeats the point. Adding overrides later means a new
  column on `dashboard_widgets`, not reinterpreting `filter_state`.
- **Cross-widget interactions** (click a bar to filter the rest), scheduled
  email/export, and dashboard duplication.
- **AI-authored widget config.** The natural next step — Ask SILO already
  returns `queries_run`, and `visual_config` is a small JSON object, so
  "chart that by units instead" is a field edit, not generated code. The
  deterministic `recommend()` in `chart-adapter.js` is the placeholder for it.

## Testing

```bash
node v3/tests/run.js --unit      # needs nothing installed
node v3/tests/run.js             # everything
```

Ten suites, ~310 checks, in `v3/tests/` — see its
[README](tests/README.md). `.github/workflows/v3-tests.yml` runs them on any
push or PR touching `v3/`, with no secrets, because nothing there talks to a
real database.

Five unit suites cover the pure modules. Five browser suites drive the real
pages in Chromium against a stubbed Supabase — **the pages are served
unmodified from the repo**, so the real `dashboard.html` runs the real
`dashboard-renderer.js` and only the outside world is faked.

Two things worth preserving if you change how any of this is tested:

**`report-params.js` stays under test whatever else moves.** It is the one
file that turns a value from a control into part of a query, and its suite
includes the injection attempt each type must refuse — `1 or 1=1` into a
number, a quote-break into text, an undeclared option into an enum, a
`{{token}}` nobody declared.

**Assert on what reached the RPC, not on pixels.** The fake Supabase records
every call in `window.__FAKE_DB__.rpcCalls`, and the strongest assertions read
that array: the resolved SQL carried the expected literal, an invalid value
produced *zero* calls. A tile can look right and be running the wrong query —
which is exactly how two widgets shipped rendering an `information_schema`
lookup.
