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

## Files

| File | Role |
|------|------|
| `dashboards.html` | List / create dashboards |
| `dashboard.html` | The canvas. `?id=<uuid>` to view, `&edit=1` to edit |
| `dashboard.css` | Tile chrome, inspector, picker. Beacon tokens only — no new CSS variables |
| `js/field-semantics.js` | What a column *means* (currency / count / percent / date / category), resolved from four layers. No ECharts, no DOM |
| `js/chart-adapter.js` | The only file that talks to ECharts. Profiles rows, recommends a visual, groups/sorts/limits, builds options, renders table/KPI HTML |
| `js/dashboard-renderer.js` | Owns the GridStack instance and draws widgets from config. Used unchanged in view **and** edit mode |
| `js/dashboard-builder.js` | Edit mode only: report picker, inspector, buffered save |

Libraries are CDN-loaded and version-pinned: GridStack 10.3.1 (canvas
interactions) and ECharts 5.5.1 (charts).

## Tables

`dashboards` and `dashboard_widgets` (migration `20260828120000_v3_dashboards.sql`),
plus the `dashboards_v` / `dashboard_widgets_v` `security_invoker` views. RLS
follows the existing company-membership model; widget access is entirely
inherited from the parent dashboard via an `EXISTS`.

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

## Deliberately not built yet

Named here so nobody reads their absence as an oversight:

- **Dashboard-level filters** (date range, location, entity). These want to push
  down into the report's SQL to be honest, and the SQL is opaque text a widget
  does not own. Filtering the 500 returned rows client-side would look like a
  filter and behave like a sample.
- **An "Add to dashboard" button inside Ask SILO.** The hop exists in the other
  direction (the picker reads saved reports); adding the outbound button means
  editing `v2/silo-chat.html`, which is its own change.
- **Cross-widget interactions** (click a bar to filter the rest), scheduled
  email/export, and dashboard duplication.
- **AI-authored widget config.** The natural next step — Ask SILO already
  returns `queries_run`, and `visual_config` is a small JSON object, so
  "chart that by units instead" is a field edit, not generated code. The
  deterministic `recommend()` in `chart-adapter.js` is the placeholder for it.

## Testing

`chart-adapter.js` is pure and testable in node (no DOM needed for profiling,
shaping or formatting). The full path — add a report, switch Table ↔ Bar ↔ Line
↔ Donut ↔ KPI, drag/resize, save, reload identically — was verified in Chromium
against a stubbed Supabase client during development. There is no test runner
checked into this repo to hang those on yet; see `docs/ops/roadmap.md` (smoke
tests).
