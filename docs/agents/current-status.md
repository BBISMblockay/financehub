# Module status and repo history

> Moved verbatim from the root `CLAUDE.md` on 2026-10-07 (agent-guide restructure). The root file keeps the rules; this file keeps the detail and history. Update here, not in the root.
>
> The Stripe, Customers and AI-credit entries were corrected on 2026-10-07. Other entries are as of when they were written; trust the code, `v2/nav-config.js` and `supabase functions list` over this file.

## Current status (as of Aug 2026)

For a change-by-change history read `docs/ops/CHANGELOG.md` — it is kept current and is more detailed
than this section.

### Modules shipped since the multi-tenant work
- **Shopify API sync** — replaced the Google Sheets / Better Reports pipeline as the sole sales +
  inventory source (`shopify_connections`, `scripts/lib/shopify-sync-core.mjs`)
- **Accounting Export** (`/v2/accounting-export.html`) — month → journal-ready entries + deposit
  register, backed by `shopify_payouts` and `accounting_coa_map`. "Build & post journal entry"
  extracts the ACTUAL computed lines (`salesEntryLines()` per location bucket, `feeRowsByStore()`
  per payout store — the same functions the Sales Journal card and the Journal CSV already use) and
  stages them through `v2/je-composer.js` in one shot, rather than a blank form someone retypes 20+
  rows into by hand. Refuses to build (rather than posting garbage) when any line is unmapped.
  `accounts_receivable` is a true `Accounts Receivable`-typed account today, so every line that hits
  it needs a QuickBooks customer before it can post — a real month is ~22 such lines with no natural
  single customer to assign; said up front with the exact count rather than left as a surprise at
  the review step. This is also what forced `je-composer.js` to stop rendering account/location/
  entity as always-live `<select>`s: a real month is 100+ lines, and building three full option
  lists (450 accounts × 64 locations × 422 entities on Baseballism's chart) per row measured 5.6s to
  open. They now render as a label button that becomes a real select only on click and collapses
  back after — 74ms to open the same 106-line entry, the identical fix Card Coding's table needed
  for the same reason
- **Mailroom** (`/v2/mail-intake.html`, `/v2/mailroom.html`) — intake, routing, email notifications
- **Org Calendar** (`/v2/calendar.html`) — one time layer over launches, tasks, POs, AP, payroll,
  live slots and mail via the `security_invoker` `calendar_events_v` union
- **Task Manager** (`/v2/tasks.html`), **TikTok Live schedule** (`/v2/live-schedule.html`),
  **Products** (`/v2/products.html`, replacing the old product-manager pages)
- **Marketing Report** (`/v2/wow-report.html`, formerly "Week over Week") — reads at four grains
  via `wow_window(report_date, grain)`, which **all eight `wow_*` RPCs delegate to** so a grain
  cannot mean one thing in the KPI band and another in the funnel. Month and YTD are TO-DATE (a
  partial month against a complete one reads as a collapse every time); YTD's "previous" is the
  equal-length window ending Dec 31, not last year's YTD, which the LY column already holds.
  `wow_window` is marked **ROWS 1** — as a set-returning function the planner assumes 1000 and
  every RPC joins it `cross join w`, which took `wow_kpi_compare` from sub-second to timing out.
  Ad-level creatives (`wow_creatives`) group by campaign objective and **each objective is judged
  on the metric it was bought on** — ROAS/CPA only under Purchases; a Subscribers "CPA" is cost
  per PURCHASE on a lead campaign and misleads harder than a blank. Organic posts
  (`wow_organic_posts`) rank by views and divide engagement by REACH, never views. Notes are keyed
  `(company, report_date, grain)`. **The three Marketing pages do not share a revenue definition:**
  the Report and Performance read actual Shopify online sales, Explorer reads platform-CLAIMED
  `conversion_value` (~75c claimed per real $1). `wow_paid_media_reality()` computes the gap
  (`claim_ratio`, `mer_online` vs `mer_blended`) and is surfaced nowhere yet
- **Marketing** — direct ad-platform APIs (Google/Meta/TikTok/GA4) into `marketing_kpis_daily`,
  surfaced by `/v2/marketing-overview.html`; Supermetrics was dropped before it went live
- **Integrations** (`/v2/integrations.html`) — admin-only connection management for Shopify, ad
  platforms, and Redo
- **Compensation Requests** (`/v2/comp-requests.html`) — Team module phase 2, on top of Performance
  Reviews' `employees`/`employee_managers` roster: a manager requests a raise/bonus/promotion/equity
  change for a report, routed to finance for review/decision (`comp_adjustment_requests`, same
  approval boundary as `payment_requests`). **In the nav as of 2026-08-25**, alongside the
  Performance Reviews rollout
- **Card Coding** (`/v2/card-coding.html`) — upload a card CSV, code it, post the entry. Replaces a spreadsheet tab per card per month hand-fed to a SaaS JE uploader. Rules first (deterministic, free, auditable), then AI on whatever is left — both run automatically on import, so the feed is already coded when you first look at it — human review always, then a previewed journal entry. The coding table renders account/location as text and builds a `<select>` only for the cell being edited: at 420 rows the per-row-select version took 5.1s to open a batch and 500ms per edit (78,120 option elements); click-to-edit is 0.65s and 32ms. Search plus row selection is the bulk path — click a normalised merchant to search it, select all, set the account once. Finance-gated in the nav and by `can_manage_journal_entries()` in RLS. **Posting is off per card until switched on**; the CSV export still emits their existing uploader template, so the tool is useful before the direct post is enabled. **A transaction can be split across several accounts** since 2026-09-15 (a loan payment's principal and interest): the lines must total the transaction to the cent, and a learned split remembers the accounts and never the amounts -- see `card_transaction_splits` above and `docs/ops/card-splits.md`
- **Redo returns** — webhook + REST backfill into `redo_returns`; `/v2/returns-overview.html` exists
  but is deliberately **not** in the nav until coverage is complete
- **Product Studio** (`/v3/product-workflow.html`, Purchasing nav, 2026-09-30) — replaces Product Concepts (`/v2/product-concepts.html` forwards, keeping `?concept=`). One flow: Ask SILO concept → Studio → **Mark ready for PO** → Draft PO. **Ready for PO is not `product_concepts.status = 'approved'`**: it is a concept brief (`product_workflow_briefs`) a person marked ready (`po_ready_at/by`), checked by `product_concept_po_readiness_issues()` at marking AND at PO creation (product type, factory in the company, positive whole-unit total that the confirmed sizes sum to, explicit sized/one-size, confirmation of those exact lines, not a collection parent), bound to the reviewed brief and to a fingerprint of the concept's purchasing fields. `generate_po_from_concept()` (the legacy `po-builder.html?fromConcept=` link) hands off the same ready brief; `trg_guard_concept_po_writes` refuses browser writes attaching a concept to a PO, so the still-hidden in-builder picker (`#btnFromConcept`, still hidden -- do not unhide it) cannot bypass the gate. One concept, one PO from this flow. Old approved concepts were deliberately NOT converted. Runbook: `docs/ops/product-workflow-preview.md`
- **Dashboards** (`/v3/dashboards.html`, `/v3/dashboard.html`) — the v3 dashboard runtime: saved Ask
  SILO reports arranged on a drag/resize GridStack canvas, drawn by ECharts from stored config.
  First `/v3/` pages; they load the v2 Beacon shell unchanged, so v3 is one feature folder, not a
  second app. **In the nav as of 2026-09-08**, as three rows under `Reports` (Dashboards, Saved
  reports, Report builder) behind the SAME `EXEC_ROLES` soft-launch gate the previously
  commented-out row already carried — `Reports` is absent from `STANDARD_SECTION_ORDER`, so a
  standard-profile company still drops all three regardless of role, and nobody who could not
  already reach these pages by URL can now. `/v3/dashboards.html` is the hub, titled **Reports** since
  2026-09-22 (one sidebar row, `reports/dashboards`, labelled Reports; the separate Saved reports row
  is gone): five tabs — **SILO Reports** (`source = 'system' AND company_entity_id IS NULL`),
  **My Reports** (only the signed-in creator’s active private or shared reports),
  **Company Reports** (all active company-shared reports, including yours), **Archived**
  (your archived reports, with Restore), and **Dashboards** — defaulting to SILO
  Reports, with the tab kept in `?tab=` (`silo`/`mine`/`company`/`archived`/`dashboards`; the old `?tab=reports` lands on
  My Reports). The rules live in `v3/js/report-library.js`. A standard-profile workspace still defaults to Dashboards only; Ask SILO’s explicit
  `?manage=reports&tab=mine` link offers report management without SILO catalog or authoring nav.
  **Archive is recoverable library state**: only the creator can change it, enforced
  by RPC and a table trigger, while existing dashboards and authorized direct reads
  keep their SQL and data. `saved_report_archive_usage()` lists readable dashboard
  names plus private-board counts; the UI never guesses zero after an error. The
  unfiltered saved-report view exposes `archived_at`, so list/picker callers must
  filter it explicitly. See `docs/ops/report-management.md`. The 2026-09-22 catalog cleanup (21 → 17 SILO reports, short titles) was applied
  to prod directly; `20260922170000` re-asserts it and MUST stay the last include in
  `apply_all_post_merge.sql`, because the seed migrations upsert the long titles and the retired
  reports back. Four `source = 'system'` report definitions are seeded
  (`20260828150000`) so a dashboard has something to build on without anyone having saved an Ask
  SILO report first.
  **Presentation defaults are MODULE-WIDE (2026-09-03):** column labels (`qty_arriving_by_cutoff` -> "Qty Arriving By Cutoff", acronyms preserved), month-grain date column headers (`Jan 2025` not `2025-01-01`), negative currency/number/percent coloured (never a count -- a negative count is not a loss), KPI deltas (vs a named column or the previous row; direction in WORDS as well as colour and arrow) and per-tile number abbreviation. All of it lives in `chart-adapter.js`, which every tile on every dashboard renders through, so NO report SQL is involved and improving a default improves every existing tile at once. The override rule: a column LABEL belongs to the REPORT (`columns_metadata[col].label`) because `net_sales` reads the same everywhere and one correction should fix every widget; DISPLAY choices (abbreviate, compare) belong to the WIDGET, because a narrow tile and a wide one can legitimately differ. Apply that split to anything added here. **Matrix visual (2026-09-03):** a sixth `visual_type` -- `row_field` down, `x_field` across, `y_field` in the cells -- because a P&L is lines-down-months-across and every other visual reduces to one dimension and one measure. Row/column order comes from the QUERY (first appearance), never sorted, which is what keeps a statement in statement order; dates are the one exception. An absent cell renders EMPTY, never 0 -- "no row" and "zero" are different facts. Note `20260903200000_matrix_visual.sql` widens the `visual_type` CHECK, the only part of a visual that needs a migration (everything else lives in schemaless `visual_config`). CSS trap: Beacon declares `table.bcn-table { table-layout: fixed }` (element+class), so a bare `.dw-matrix` override silently loses and the table keeps fixed layout -- which divides width equally and made row labels paint over the first data column. Anything overriding a Beacon table needs the element selector. **Link and image cells (2026-09-03):** two RENDER semantics -- `link` draws an anchor, `image` a 44px thumbnail -- detected from the VALUES (every non-null value is an http(s) URL), never from the column name. They are the only cells that put a DB value into an HTML attribute, so both pass one guard (`^https?://`, no whitespace) that rejects `javascript:`/`data:`/`vbscript:`/`file:`/protocol-relative; a failing value renders as inert escaped text. Neither is a measure or a dimension. **Publishing a board now publishes its reports:** saving a dashboard as company-visible promotes its private reports (only those the saver may update) and reports the count, because a company board whose reports are private renders blank tiles for everyone else -- `dashboard_widgets_v` is security_invoker. **Calculated measures** in the report builder (2026-09-03): a measure over TWO aggregates (ROAS = sum(sales)/sum(spend)), every division guarded by `nullif(x,0)` so a zero denominator empties the cell instead of failing the tile, and the calculation DECLARES its own semantic -- a calculated column is in no catalog, so the grounded typing layer has nothing to say and name heuristics get `net_sales_pct_of_total` wrong ("sales" reads as money, printing 12.4% as $12.40). Also `defaultQueryIndex()`: an Ask SILO answer's `queries_run` is a TRANSCRIPT, so a widget now defaults to the last NON-PROBE query rather than index 0 -- index 0 is routinely an `information_schema` lookup, and a tile drawing one renders a list of column names that looks like it works. **Presentation batch 2 (2026-09-03):** totals, column hide/reorder, chart value labels/stacking, and section headings -- all in `chart-adapter.js`, so module-wide like batch 1. Totals are OPT-IN and refuse what cannot be summed: a RATE is left blank, never summed and never averaged (both are numbers that do not exist), and a truncated table says the total covers only the rows shown. Column selection lives on the WIDGET (two tiles on one report can want different columns); an empty list means everything, never nothing. Stacking is REFUSED across mixed semantics -- dollars stacked on a ratio is a bar whose height means nothing -- and a line never stacks. A **section** is a `visual_type = 'section'` widget with NO report: `report_id` was already nullable, so it needed no table, no renderer path and no save-buffer special case, only the `visual_type` CHECK (`20260903210000_section_widget.sql`) plus a constraint refusing an untitled section, which would be an invisible tile still occupying the grid. CSS trap #2, same family as the matrix one: `.dw` is a COLUMN flex container, so `align-items` is the HORIZONTAL axis -- `align-items: flex-end` on a section pushed every heading to the right edge; bottom alignment is `justify-content`. **Slicers shipped 2026-09-03** (`silo_chat_saved_reports.parameters` +
  `dashboards.filter_state`): a report declares `{{token}}`s, the dashboard header supplies them,
  and one control drives every tile sharing a key. The Week over Week board is the worked example —
  nine reports on one Day/Week/MTD/YTD switch, where before it was frozen at week grain.
  **Pagination shipped 2026-09-04** (`20260904320000`): `chat_run_readonly_query`'s cap raised 500 -> 1000 rows per page, with an optional `p_offset` so a report builder Preview or a dashboard TABLE widget can fetch further pages and append them (never a fresh render, so a reader mid-scroll doesn't lose their place). Charts deliberately do not page -- a bar/line/donut/KPI/matrix is a computed shape over whatever page it drew, and reshaping it live under someone reading it would be worse than the existing "hit the cap, aggregate in the report" note those visuals keep. Applying this migration live surfaced an unrelated, pre-existing hole: every drop+create of this function since late August had revoked EXECUTE from `public` but never explicitly from `anon`, and Supabase's default privileges on the `public` schema silently re-grant `anon` EXECUTE on any newly created function -- so `anon` could call this SQL-execution RPC. Closed (`20260904330000`), and `verify_v2_schema.sql` now checks for it so a repeat fails loud.
  **Answer widget shipped 2026-09-04** (`20260904340000`): a seventh `visual_type` -- `answer` -- section's inverse. It REQUIRES `report_id` and renders that report's saved ask_silo `answer` text as sanitized markdown (`marked` + `DOMPurify`, same pipeline `v2/silo-chat.html` already uses, same `del`-tokenizer patch for `"~$24K"` not becoming strikethrough); no `query_index`, no rows, nothing `chart-adapter.js`'s profiling touches. Exists because `queries_run` is a transcript and a genuinely open-ended question ("tell me about the business and suggest action items") can run 20+ queries and never reduce to one dataset -- found live on the Ownership dashboard, where a 25-query answer got added as a table pointed at the transcript's LAST query (a narrow PO lookup that correctly returned 0 rows, matching the written answer's own finding, but carrying none of that context alone). Offered in the "+ Add widget" picker (a `v3-answer-cta` button above the per-query list, pitched hardest past 3 queries) and in the inspector's Visualization picker, both gated on the widget's `report_answer` actually being non-empty -- a manual/system report never has one. Switching is non-destructive: an existing table/chart widget can be switched to Answer from its own inspector (same report, different `visual_type`, no delete-and-re-add), and `addAnswerWidgetFromReport()` still resolves a real `query_index`/`query_sql` at creation time so switching back to Table later lands on a sensible dataset rather than a blank tile.
  **BI workspace pass, 2026-09-08.** Four reliability failures found in live testing, each fixed at its cause: (1) a saved PARAMETERISED report added to a board read "not a declared parameter" until save+reload, because the picker's nine-column select omitted `parameters` and the local widget got `report_parameters = undefined` — `columns_metadata`/`answer`/`source` had the same shape of bug, so one `REPORT_FIELDS` list and one `reportFieldsFor()` now build the denormalised half of a widget; (2) a TEXT filter never committed, because the bar committed on `change` (blur/Enter) and every apply rebuilt its own `innerHTML`, discarding what had been typed — hence `js/filter-bar.js`, fields built once and updated in place, typing held as a named pending state, guarded on PENDING and never on focus (guarding on focus is what left Reset showing the value it had just reset away from); (3) a new KPI took the first numeric column, so a card titled "Total sales" showed MLB sales — `kpiField()` now falls back only when there is exactly ONE numeric column and otherwise prompts, and **the title is never evidence**; (4) the header wrapped, so the description moved behind an information disclosure.
  **`js/metrics.js` is the shared metric layer** above `field-semantics.js`: a ratio is aggregated from its numerator and denominator or REFUSED, never averaged (2% over 100 sessions and 10% over 10,000 is 9.9%, not 6%). **`isRatio(field, semantic)` asks the `RATIOS` lookup OR the semantic, and is asked BEFORE the requested aggregate** — both halves of that were bugs found in review: an explicit `avg` used to skip the ratio branch entirely (and `defaultAggregate('percent')` is `avg`, so the inspector shows it on every rate), and a ratio that is not a percentage never reached it at all, so AOV of $10 and $100 summed to $110 and ROAS of 2 and 8 summed to 10. `first`/`last`/`min`/`max`/`count` stay honoured — they select a row rather than manufacturing a ratio. `chart-adapter.js`'s `shape()` pools through the same function when it groups, or a bar chart and the KPI beside it would disagree; where the parts are absent a KPI refuses and a chart falls back to the unweighted mean and says so in its footer, and neither ever sums; a rate's change is in percentage POINTS with the relative change in brackets; `priorPeriod`/`priorYear` return their window so a comparison's dates can be printed; Total Sales and Net Sales are labelled in full, always. Validated against prod on 1–6 Sep 2026: MLB $55,463.51 of $637,832.00 = 8.70% pooled, where averaging the six daily shares gives 11.74% — three points. Kept as a test fixture, not as an MLB feature.
  **Three more visuals** (`20260908140000` widens the CHECK): `combo` (bars plus a `line_measures`-named reference line, for two measures on a similar scale where the axis heuristic cannot infer one), `heatmap` (the matrix's shape, coloured; rows inverted so it reads top-down like the matrix, absent pairs drawn as GAPS) and `waterfall` (query order forced, a step labelled like a total drawn from zero, rates refused). `validateVisual()` gates the PICKER, not only the draw. Stacked bars and the KPI sparkline needed no migration — both live in `visual_config`.
  **Tables** gained search, click-to-sort (`aria-sort`, real buttons), a sticky header, a focusable scroller, conditional formatting and CSV. Search/sort are READER state held outside `visual_config`; `tableRows()` is the single decision about which rows so the export cannot disagree with the screen, and a capped or filtered export names its scope IN THE FILE.
  **Canvas** gained duplicate (deep-copied config), full screen (the body is MOVED, so a chart keeps its instance), collapsible sections (view-mode only, restoring exact geometry), per-visual size constraints that follow the visual TYPE, and a compact/comfortable density that changes no geometry. Two GridStack traps: `grid.update(el, {minW,minH})` treats an omitted `w`/`h` as UNSET and wiped every tile's size; and the 1-column collapse runs before any widget exists, so tiles were added at their 12-column `y` and each collision pushed the earlier one down — inverting every row on a phone (`stackForNarrowScreen()` places them in reading order instead).
  **The inspector is Data | Visual | Format | Interactions**, and the TILE is the live preview (ringed and scrolled to). **Clicking a value** cross-filters through the PARAMETER system — never by hiding fetched rows, which would put two irreconcilable numbers on one screen — or drills through carrying the clicked value AND the whole current filter position; only dashboards the user can already open are offered.
  **Personal saved filter views** (`dashboard_filter_views`, `20260908130000`): a name plus a `filter_state`, creator-only by RLS, so keeping "my cut" of a board no longer means duplicating the board and its widgets. The page feature-detects the table, so page and migration ship in either order.
  **Visual language refreshed 2026-09-10** (presentation only, `chart-adapter.js` + `dashboard.css`, no SQL and no stored widget): symbols only on a line series of two points or fewer (one point with no symbol renders a BLANK tile), a gradient fill fading to the axis instead of a flat tint, solid hairline gridlines with `grid` (structural) and `gridline` (the scale) now separate colours, **words in the sans and numbers in the mono**, a KPI whose caption leads and whose change is a tinted pill, the total drawn in the donut's hole, and a 10px card whose head only looks like a drag handle in edit mode. Gradients are PLAIN OBJECTS, never `echarts.graphic.*` -- the unit suites build every option in node with no echarts global. Two things not to re-try: a horizontal ECharts scroll legend PAGINATES rather than wrapping (a bottom donut legend showed three of six names and a `1/3` pager), and a tile radius of 10px is the one deliberate departure from beacon's `--bcn-radius`. Details and the full before/after table are in `v3/README.md`.
  **Tests live in `v3/tests/` and run in CI** (`.github/workflows/v3-tests.yml`, no secrets): `node v3/tests/run.js --unit` needs nothing installed; the browser suites need `cd v3/tests && npm install && npx playwright install chromium` and are SKIPPED (not failed) without them. Twenty-five suites. Read `v3/README.md` before changing any of it — it records what was deliberately left out
  (per-widget parameter overrides, an "Add to dashboard" button in Ask SILO, scheduled export, AI-authored widget config)
- **Stripe billing + Connect invoicing** (`/v2/billing.html`, `/v2/invoicing.html`, 2026-09-19) —
  two Stripe surfaces kept structurally apart: Billing is what a tenant pays SILO (SILO is the
  merchant), Invoicing is the tenant billing **their own** customers through **their own** Connect
  Standard account (the money settles to them, SILO holds no funds and stores no key for them).
  Every table is a read-only mirror of Stripe with no client write policy at all; one webhook
  function receives both surfaces and tells them apart by which signing secret verified the
  delivery. **Invoicing is in the nav** (checked 2026-10-07): it is one of the Accounting suite's
  pages (`ACCOUNTING_PAGES` in `v2/nav-config.js`), gated `FINANCE_DEPTS` to mirror
  `can_manage_client_invoices()`. **Billing is the Billing tab of Workspace Settings** (2026-09-20)
  and reachable by an admin — a deliberate choice **confirmed by Blake 2026-09-20**: do not hide the
  tab as a tidy-up. Both rows landed alongside the
  restore of `v2/nav-config.js` itself, which `631ff17` had deleted while every Pattern 1 page
  still loaded it. **The four Edge Function handlers live in `handler.ts` with a two-line
  `index.ts`** — the plaid-finance split — so `scripts/tests/stripe-handlers.test.mjs` can
  execute them under node with fake Stripe and Supabase; `deno check` proves types, not
  behaviour. **Deployed** (checked 2026-10-07 against `supabase functions list`): `stripe-billing`,
  `stripe-connect`, `stripe-invoice` and `stripe-webhook` are live and match `main`. Setup steps and
  webhook configuration: `docs/ops/stripe.md`
- **AI credit** (2026-10-01, `docs/ops/ai-credits.md`) -- Billing shows the workspace's AI-credit balance, period usage by feature and On Deck's cap STATE (never its provider-dollar amount); Ask SILO shows the balance pill and each answer's settled cost. Applied: production has an `ai_billing_settings` row in `shadow` mode (checked 2026-10-07). Without a row, AI credit is off. Open decisions (trial allowance, refunds, auto-refill, who may spend, the superseded 2026-09-24 trial/spend-limit decisions) are listed in the runbook
- **Customer accounts** (`/v2/customers.html`, `/v2/customer-onboarding.html`, 2026-09-19) — a
  wholesale customer is invited by email, fills in the application themselves on a public
  token-gated page (business identity, contacts, business/ship-to/bill-to addresses, resale
  certificate upload, requested terms), saves a card through Stripe Checkout `mode: 'setup'` on the
  tenant's Connect account, and finance reviews and approves. This is **SILO's first native
  customer master** — see `customer_accounts` above for why none of the four existing
  customer-shaped tables could hold it. **In the nav** (`finance/customers`, `FINANCE_DEPTS`) and
  `customer-onboarding` is deployed (both checked 2026-10-07). The Connect webhook endpoint must carry
  `checkout.session.completed` + `checkout.session.expired`; runbook: `docs/ops/customer-onboarding.md`. Vendor onboarding
  (W-9, remit-to, bank/ACH) is deliberately out of scope — a more sensitive record wanting its own
  gate, and `payment_requests` still identifies vendors by four loose text columns
- **Workspace Settings** (`/v2/settings-company.html`, `settings-team`, `integrations`, `billing`,
  `settings-notifications`, 2026-09-20) — the customer-facing settings area, drawn as ONE tab strip
  (`v2/workspace-settings.{js,css}` + `SiloNav.WORKSPACE_SETTINGS_PAGES`) in exactly the shape the
  Accounting Suite uses: real links across real pages, not a single-page shell. **Integrations and
  Billing ARE their existing pages** at their existing URLs — they gained the strip and nothing
  else, so there is no second implementation of either and no bookmark moved. One sidebar row
  (`settings/workspace`) replaces the per-page rows; `silo-chrome.js` collapses any settings tab
  onto it, same as the accounting mapping. Company (name/timezone/currency) and Team (members,
  roles, invites) are new; Notifications is READ-ONLY and derived — SILO has no per-company
  recipient list, team notifications are addressed by department and resolved at send time, so the
  page shows that resolution rather than inventing settings. **Logo is named as absent, not drawn
  as an empty control.** Sender behaviour is untouched
- **Silo Admin** (`/v2/platform-admin.html`, 2026-09-20) — platform scope, deliberately NOT a tab of
  Workspace Settings. Holds the "found a new company" control that used to sit inside
  `v2/backend.html` (which is now workspace-scoped, with a gated pointer here), every tenant via
  `platform_list_companies()`, and platform invite management. **A company owner is not a platform
  admin**: the nav row is `requiresGrant` + `grantTable: 'platform_admins'` so it appears only once
  that row is read back, and every RPC behind the page re-checks `is_platform_admin()`
- **On Deck** (`/v2/on-deck.html`, Start nav for finance, 2026-10-04) — approval-first: Ready for your review → review of the actual output → After approval. First module is transaction coding over the existing card-coding chain: `on_deck_coding_items()` (finance-gated queue), `card_import_batch_preview()` (runs `approve_card_import_batch` and ROLLS IT BACK, so the preview is exactly what approval freezes — do not replace it with a rebuilt entry), `approve_reviewed_card_import_batch(batch, hash)` — sending a copy to QuickBooks is optional and deliberately takes extra steps (`expected_approval_hash`). **Since `20261005120000` a saved categorization is the finish line**: the transaction is already in the SILO daily ledger, On Deck counts only uncategorized transactions as pending, and "Approve QuickBooks entry" is an optional monthly step (approval still requires the card's `posting_enabled` switch, which now governs only the QuickBooks entry). Home shows only a compact count (`on_deck_ready_count()`). Restock/projection → draft PO is a separate PR. Runbook: `docs/ops/on-deck.md`
- **Ask SILO** (`/v2/silo-chat.html`) — agentic chat with taught notes (`silo_chat_notes`) and a
  dedicated access grant (`silo_chat_managers`); exec-only in the sidebar during soft launch
- **Ad Studio** (`/v2/ad-studio.html`, 2026-09-27, Marketing → Ad Studio, `EXEC_ROLES` soft launch) — past Meta ads as baselines and an idea bank. `ad_studio_ads(p_days)` returns per-ad SUMS over the newest ingested window; `v2/ad-studio.js` pools every rate from those parts (never an average of per-ad rates) and judges each objective on what it was bought on: purchase on Meta-REPORTED ROAS, ThruPlay on cost per ThruPlay, subscribers on cost per lead, traffic on CPC, followers/other on CTR (SILO has no follow counts). Evidence is a word from the volume behind a number (e.g. ROAS on under 15 purchases is "early" and is never ranked), findings are observations with their numbers, never a claim about why an ad worked. Images come from the archive above through signed links; an ad without one reads "not archived yet", and a shared template image says so. "Add to idea bank" / "New idea from selected" (one objective at a time, so a bar is one measure) writes an `ad_ideas` row with the frozen bar; "Draft with Ask SILO" fills the composer via `?q=` and never sends
- **Nav profiles** (`v2/nav-config.js`) — grandfathered vs standard menus, plus department/role/grant
  gating. This replaced the hardcoded nav that used to live in `silo-chrome.js`

### Multi-tenant isolation — Phase 1 complete
DB-level company isolation is live. Users in multiple companies pick a company at login; all data reads are scoped to `profiles.active_company_id`. See `supabase/README.md` for migration details.

**Deferred:** per-company sync pipelines, company switcher in sidebar. (The `inventory_on_hand` / `sales_by_day` backfill that older versions of this line listed was completed — see "Isolation status" above.)

**Attribution:** every table with a `created_by`/`changed_by` column has a `stamp_created_by`/`stamp_changed_by` BEFORE INSERT trigger (auth.uid() when not explicitly passed; service-role syncs stay null). Rows created before 2026-07-14 are unattributed and unrecoverable.

### Tools fully on Beacon shell (Pattern 1)
See the Pattern 1 list above — 33 pages. **Exception:** `v2/backend.html` is *not* on the Beacon shell
despite older notes saying so. It loads Tailwind from `cdn.tailwindcss.com` and mounts neither
`nav-config.js` nor `silo-chrome.js`. It is the only page using Tailwind; treat it as its own thing
until it is rebuilt. `v2/company-picker.html`, `v2/company-onboarding.html` and `v2/launch-calendar-guide.html` are also
intentionally chrome-less (pre-company-selection / pre-company-existence / standalone doc).

### Performance Reviews module (complete as of 2026-07-14)
End-to-end flow across five pages + three edge functions:
1. Exec/owner builds templates (`/v2/review-templates.html`) — publish locks questions; revise via duplicate-as-draft
2. Managers roster employees + run reviews (`/v2/reviews.html`, `/v2/review-editor.html`) — manager-scoped RLS: managers see ONLY their own roster/reviews; exec/owner see all; private notes are author-only. An employee can have more than one manager (`employee_managers`, many-to-many) — each co-manager sees them on their own roster and runs their own independent review; the roster page's Managers list lets any current co-manager add another
3. Send emails the employee a hashed 30-day token link (Resend, `noreply@silo-baseballism.com`)
4. SILO-authenticated employees view/sign in-app (`/v2/my-review.html`); associates (no SILO login) use the public portal (`/pages/review.html`) — the token is the entire authorization
5. Signing marks the review finished (immutable — sent/finished reviews cannot be deleted), locks tokens on both paths, and emails the manager
Goals persist on the employee across cycles (`employee_goals`) and surface in every review regardless of template. PDF = print stylesheet on both review views.

### Tools on tool-shell iframe (Pattern 2)
See the Pattern 2 list above. Their iframe targets live at the repo root (or `/pages/`), and most of
them are Google-Sheets-backed with no Supabase and no auth of their own.

### Repo drift to be aware of (audited 2026-08-16)
Not bugs to fix blind — context so you don't mistake leftovers for live code:
- **Retired 2026-08-16:** `accountspayable.html`, `ap-report.html` (superseded by Request Manager),
  and the `allocation` / `aprio` / `cashflow` / `modelapps` / `recon` / `travel` / `wpvaccounts` pairs
  (root target + `v2/` wrapper; stale Google Sheets flows). Their entry points went with them: the
  WPV and Travel Report nav rows, both Home links, and the Cash flow option in the profile
  default-landing-page dropdown
- **Superseded originals were retired 2026-10-01:** root `inventory.html`, `projections.html`,
  `mailroom.html`, `executive.html`, and `employeehub.html`. Current inventory, mailroom, projections
  and Finance pages remain under `/v2/`. See `docs/ops/legacy-page-retirement.md` for exact scope.
- **Root iframe targets are directly reachable and ship no auth of their own.** The two that
  loaded for anyone, `buyer.html` and `checkwriter.html`, were deleted 2026-10-06 (keepsakes saved
  privately). A v2 wrapper's auth gate never covers its target's own URL
- **Payroll BI was retired 2026-08-17** (`payroll.html` + `v2/hidden/payroll.html`) — a bad flow, per
  Blake. The payroll TABLES remain in Postgres and are still referenced elsewhere: `live-schedule.html`
  files host payouts as `request_type = 'payroll_payment'`, and `calendar_events_v` projects
  `payroll_import_batches.check_date` as payday events. **That calendar branch still deep-links to
  `/payroll.html`, which no longer exists** — see the note in `docs/ops/org-calendar.md`
- **`v2/profile.html`'s `LANDING_OPTIONS` offered `/finance.html` and `/ops.html` until 2026-09-10** —
  neither file exists, so picking either set a `profiles.default_page` that 404'd on next login. Fixed:
  the list now holds only pages that exist, and a stored value that is no longer offered renders as a
  flagged option rather than silently collapsing to "(department default)". `index.html`'s signed-in
  router had the same bug for the ops / planning / marketing / retail departments (root `/ops.html`
  etc.) and now lands everyone on `/v2/finance.html`, matching `pages/login.html`. Any profile that
  still STORES one of the dead paths keeps 404-ing until its owner re-saves — a one-line
  `update profiles set default_page = null where default_page in ('/finance.html','/ops.html')` clears it
- **Orphan CSS:** `v2/po-builder-beacon.css` and `v2/purchasing-hub-shell.css` have zero references
- **`v2/hidden/`** is parked-on-purpose (not in nav, no inbound links). **`v2/licensing/`** holds
  retained assets after its entry page was retired 2026-10-01. **`config.json`** (JotForm routes) has no reader anywhere in the repo
- **Nav ids in Pattern-2 wrappers can be stale.** Several `data-tool.active` keys
  (`finance/cashflow`, `purchasing/buyer`, `ops/modelapps`, …) no longer exist in `nav-config.js`, so
  those pages highlight nothing in the sidebar

### Open roadmap items
See `docs/ops/roadmap.md` for current priorities. Key items:
- Company switcher in sidebar (without full logout)
- Finish Beacon shell migration for the remaining iframe pages
- Smoke tests

Done since that file was last pruned: per-company nav menu (`v2/nav-config.js`) and insert-side
`company_entity_id` stamping (DB trigger + `withCompany()` helpers).

### Known P2 items
See `docs/ops/bugs.md`. No open P1s.
