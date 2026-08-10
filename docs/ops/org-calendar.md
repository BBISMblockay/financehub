# SILO Organization Calendar — audit, architecture & build plan

Status: **V1 foundation shipped** (see "What shipped in V1" at the bottom).
This doc is the audit + architecture record for the org-wide calendar layer.

---

## 1. Existing state

### The only real calendar today: Launch Workbench (`/v2/launch-calendar.html`)
- Fully custom 7-column CSS-grid month view (no library) + a 21-day rolling
  agenda feed. Two date axes: `launch_calendar.launch_date` (launch chips) and
  `launch_channel_items.scheduled_date` (initiative chips in the same cells).
- Deep link: `?launch=<id>` opens the drawer.
- Specialized product workflow (readiness, assets, comments, channel plan) far
  beyond date display → it **stays its own tool** (Option 2 from the brief) and
  feeds the org calendar as a source.

### "Agenda" — there is no standalone Agenda tool
- `tasks.html` (Task Manager) is a flat table over `launch_tasks` with
  due-date buckets; no chronological view.
- The launch workbench's *feed* tab is the only agenda-style UI.
- The nightly **insights engine** (`compute_silo_insights()`, surfaced in
  `/v2/insights.html`) is the only server-side cross-tool aggregator. It reads
  all six date domains (launches, launch tasks, POs, AP, AR, sales/inventory)
  but emits severity findings, not dated events. Its domain taxonomy and
  deep-link pattern transfer directly to the calendar; its data layer does not
  (SECURITY DEFINER, service-role-only, one digest row per company).
- `v2/profile.html` builds a personal "attention feed" from 8+ client-side
  queries — per-user, browser-side, not reusable.
- **Conclusion: no second aggregation architecture exists to conflict with.**
  The calendar view introduced here becomes the first shared date layer, and
  the profile feed / a future Agenda can later re-point at it.

### Other date-bearing tools
- PO trio (`po-builder/po-costing/po-report`): `po_headers.order_date`,
  `req_ship_date`, `expected_arrival_date`; po-report is already an
  "incoming goods timeline" as a sorted table. Deep link `?po_id=<uuid>`.
- Request Manager: `payment_requests.due_date` with a 6-way due-bucket filter.
  **No deep link support** (`?request=` does not exist yet).
- Mailroom: `mail_items.received_date` / `due_date`, deep link `?item=<id>`.
- TikTok Live schedule: `live_sessions.slot_start` — the only `timestamptz`
  slot table and the only timezone-correct date modeling in the schema.
  **No deep link support.**
- Payroll (root `payroll.html`, grandfathered): `payroll_import_batches.
  check_date` + pay-period range. Finance/admin-gated at the DB.
- Travel: **not in Supabase at all** — a Google-Sheets-backed legacy tool with
  its own hand-rolled month grid. Cannot feed the calendar until migrated.
- Checkwriter / recon / allocation / cashflow: CSV/localStorage/Sheets tools,
  no DB dates. Excluded until they have real tables.

---

## 2. Date source inventory

| Source | Table | Date field(s) | Meaning | Calendarize? | Event type | Who can SELECT (RLS today) |
|---|---|---|---|---|---|---|
| Launch Workbench | `launch_calendar` | `launch_date` (+`launch_time`) | Product launch/drop | **Yes (V1)** | `launch` | all company members |
| Launch Workbench | `launch_channel_items` | `scheduled_date` (+time) | Email/SMS campaign send | **Yes (V1)** | `campaign_send` | all company members |
| Task Manager | `launch_tasks` | `due_date` | Task deadline | **Yes (V1)** | `task_due` | company, minus private tasks (assignee/creator only) |
| PO Builder | `po_headers` | `req_ship_date` | Factory ship date | **Yes (V1)** | `po_ship` | admins + PO creator only |
| PO Builder | `po_headers` | `expected_arrival_date` | Inventory arrival | **Yes (V1)** | `po_arrival` | admins + PO creator only |
| PO Builder | `po_headers` | `order_date` | PO placed | No — bookkeeping, not forward-looking | — | — |
| PO Costing | `po_costing` | `shipped_at`, `factory_invoice_date` | Costing workflow stamps | No — workflow internals | — | — |
| Request Manager | `payment_requests` | `due_date` | Vendor payment due | **Yes (V1)** | `payment_due` | AP managers (admin tier or dept finance/admin/exec) + own rows |
| Request Manager | `payment_requests` | `date_completed` | Paid date | No — historical | — | — |
| Payroll | `payroll_import_batches` | `check_date` | Payday | **Yes (V1)** | `payroll_payday` | admins + finance dept only |
| Payroll | `payroll_import_batches` | `pay_period_start/end` | Period bounds | No — context, not events | — | — |
| Live schedule | `live_sessions` | `slot_start` (timestamptz) | Claimed live-stream slot | **Yes (V1)** | `live_session` | all company members |
| Mailroom | `mail_items` | `due_date` | Mail action deadline | **Yes (V1)** | `mail_due` | all company members |
| Mailroom | `mail_items` | `received_date` | Mail arrived | No — intake log | — | — |
| Products | `product_tracker` / `product_samples` | `bulk_eta` | Bulk production ETA | Phase C — dates are soft/shifting | `bulk_eta` | all company members |
| Products | `product_samples` | `sent_at`…`photo_received_at` (5× `date` despite `_at` names) | Sample pipeline steps | No — pipeline stamps | — | — |
| Wholesale AR | `ar_invoices` | `due_date` (`is_open`) | Customer payment due (money in) | Phase C — high row volume, needs its own toggle | `ar_invoice_due` | all company members (dept hiding is client-side only) |
| Reviews | `employee_goals` | `target_date` | Goal deadline | Phase C | `goal_due` | manager/exec/self via employees RLS |
| Reviews | `reviews` | `period_label` (text!) | Review cycle | **Blocked** — no date columns | — | — |
| Projections | `revenue_projections` | `projection_date` | Daily plan grain | No — a data grain, not events | — | — |
| Marketing | `marketing_campaign_bank` | `earliest_start`/`latest_end` | Campaign windows | Phase C | `campaign_window` | all company members |
| Shopify | `shopify_payouts` | `payout_date` | Bank deposit | Phase C (finance digest) | `payout` | all company members |
| Travel | — (Google Sheet) | Departing/Return | Employee travel | **Blocked** — no table | `travel` | n/a |

### Dates that should exist but don't
- `employees`: no hire date / anniversary / termination → no People events.
- `reviews`: no `period_start`/`period_end`/`due_date` — cycles are free text.
- `launch_calendar`: design-due date lives in `notes` as free text.
- No travel table, no PTO table, no holidays table (manual events now cover
  holidays/company dates).
- `launch_calendar.launch_time` has no timezone (zone stuffed into notes);
  `live_sessions.slot_start` is the model to follow for new timed columns.

---

## 3. Recommended architecture: **Hybrid (Option C)** — decided

**A `calendar_events` table for manual events + a `security_invoker` UNION
view (`calendar_events_v`) that projects system dates from source tables.**

Why this wins in *this* codebase specifically:

1. **RLS propagates through `security_invoker` views for free.** Every SILO
   view already runs as the caller (migration `20260616030000`). A UNION-ALL
   projection view therefore inherits each source's own SELECT policy: a
   member-tier user silently gets no PO or payment rows, a non-finance user
   gets no payroll rows, private tasks stay private. No new ACL layer, no
   SECURITY DEFINER escape hatch, no way for the calendar to leak what the
   source tool hides. This kills Option B's biggest cost (keeping a registry's
   copied rows in sync with source records AND re-implementing their
   visibility) and is the decisive argument.
2. **No stale data / no duplicate-write paths.** Sources stay authoritative;
   an edited launch date moves on the calendar instantly. Option B would need
   triggers on 8+ tables plus backfills, and deleted source rows would strand
   registry rows.
3. **Manual events genuinely need a table** — holidays, board meetings,
   closures have no system of record. That is the only "registry" we need.
4. Precedents already in the repo: `v_po_open_planning_lines` derives
   `coalesce(expected_arrival_date, req_ship_date, order_date) as
   planning_date` (one canonical date per record), and `launch_system_links`
   (`ref_table`/`ref_id`/`ref_url`) is the polymorphic source-pointer shape we
   reuse in the event contract.

Performance: queries are always range-bounded (`start_on between $from and
$to`); Postgres pushes the date predicate into each UNION branch, and each
branch is a single indexed table scan. Source-table date indexes added in the
migration. At SILO's scale (thousands of rows/source) this is comfortably
fast; if a branch ever gets hot the escape valve is materializing *that
branch*, not abandoning the projection.

Rejected:
- **Pure projection (A):** no home for manual/company events.
- **Registry (B):** duplicate data, stale-sync risk, re-implemented RLS —
  all cost, no benefit at this scale.
- **Backend API service:** SILO has no backend server; the browser-to-Supabase
  pattern with RLS *is* the API. A REST endpoint would be net-new
  infrastructure against every convention in this repo.

---

## 4. Schema (migration `20260810120000_org_calendar.sql`)

- `calendar_events` — manual events only: `title`, `description`,
  `event_type` (constrained), `start_on date not null`, `end_on date`
  (inclusive, null = single day), `start_time time` (null = all-day),
  `visibility` (`company` | `finance` | `private`), `location`, `url`,
  `company_entity_id`, `created_by`. Standard stamp triggers
  (`stamp_created_by`, `stamp_company_entity_id`) attach automatically.
- `calendar_events_v` — the org-wide projection (see §5 for the contract):
  manual events ∪ launches ∪ campaign sends ∪ open task due dates ∪ active-PO
  ship/arrival dates ∪ open payment-request due dates ∪ payroll check dates ∪
  live slots ∪ open mail due dates. `security_invoker = true`.
- Supporting indexes on `calendar_events(company_entity_id, start_on)` and on
  the source date columns the view scans.

Timezone decision: all-day events are plain `date` (rendered as-is, no tz
math — matching every existing page). The one timed source, `live_sessions.
slot_start`, is projected to Pacific time (`America/Los_Angeles`) for its
calendar day + time; PT is the anchor the live tool's slot grid is designed
around (8am ET → "3am ET = midnight PT"). If a second company ever needs a
different home zone, add `entities.meta.timezone` and swap the constant for a
lookup — the view is the single place to change.

## 5. Event contract

Every row of `calendar_events_v` (what the frontend consumes):

```
event_id      text     -- '<source_type>:<uuid>' — stable, unique
source_type   text     -- 'manual' | 'launch' | 'launch_channel_item' | 'launch_task'
                       -- | 'po' | 'payment_request' | 'payroll_batch'
                       -- | 'live_session' | 'mail_item'
source_id     uuid     -- PK of the source row
event_type    text     -- taxonomy leaf, see §6
category      text     -- taxonomy group: product | supply_chain | finance
                       -- | people | operations | company
title         text
detail        text     -- secondary line (vendor, factory, assignee…)
start_on      date     -- calendar day (always set; range queries bind on this)
end_on        date     -- inclusive; null = single-day
start_time    time     -- null = all-day
all_day       boolean
status        text     -- source status verbatim ('open', 'Shipped', …)
amount        numeric  -- only where the source RLS already gates it (AP due)
owner_id      uuid     -- assignee/claimer/creator where meaningful
url           text     -- deep link into the source tool, row-level when the
                       -- target page supports it
source_label  text     -- 'Launch Workbench', 'Request Manager', …
company_entity_id uuid
```

Deep-link targets used: `launch-calendar.html?launch=`, `po-builder.html?
po_id=`, `mailroom.html?item=`, `tasks.html`, `request_manager.html`,
`live-schedule.html`, `/payroll.html`. Known gap: request_manager and
live-schedule accept no row params yet — page-level links for now; adding
`?request=` / `?date=` there is a Phase-B follow-up.

## 6. Taxonomy

| category | event_type (V1) | Phase C+ |
|---|---|---|
| `product` | `launch`, `campaign_send` | `campaign_window`, `bulk_eta` |
| `supply_chain` | `po_ship`, `po_arrival` | receiving deadlines |
| `finance` | `payment_due`, `payroll_payday`, `deadline` (manual: tax/close) | `ar_invoice_due`, `payout` |
| `people` | — | `goal_due`, review cycles, PTO, anniversaries |
| `operations` | `task_due`, `mail_due`, `live_session`, `milestone` (manual) | travel |
| `company` | `company_event`, `holiday`, `meeting` (all manual) | — |

Manual `event_type` values: `company_event`, `meeting`, `holiday`,
`deadline`, `milestone` — each mapped to a category in the view.

## 7. Permissions

**Rule: the calendar can never show more than the source tool.** Enforced in
the database, not the frontend:

- System events: `security_invoker` + source RLS (see inventory table for the
  exact per-source posture). Nothing re-implemented, nothing to drift.
- Manual events: three-level visibility on `calendar_events` RLS —
  `company` (any active member of the company), `finance`
  (`current_user_can_manage_payment_requests()` — the existing admin-tier-or-
  finance-dept helper; no new role function invented), `private` (creator
  only). Writes: any member creates; creator or admin edits/deletes.
- Company isolation: `company_entity_id = active_company_id()` everywhere, as
  usual. Consequence: the calendar shows the **active company only** — the
  brief's "All Companies" filter is impossible under SILO's active-company RLS
  model and is intentionally out of scope (the company switcher is the
  company filter).
- Deliberately NOT surfaced, ever: `review_private_notes`,
  `review_access_tokens`, `org_invites`, `job_sync_state` (deny-all tables).

## 8. UX (shipped as `/v2/calendar.html`)

Pattern-1 Beacon page, nav `planning/calendar`, month view modeled on the
launch workbench grid + an agenda (upcoming) view; KPI band (events this
month, payments due, POs inbound, launches); filter bar with category chips,
event-type select, and search; click → detail drawer with source fields +
"Open in <tool>" deep link; "New event" modal for manual events (edit/delete
for creator/admin). Timeline/week views deferred until month+agenda prove out.

## 9. Integration map & build phases

**Phase A+B (this PR):** schema + view + page, with launches, campaign sends,
task due dates, PO ship/arrival, payment due, payroll paydays, live slots,
mail due, manual events.

**Phase C (data next):** `ar_invoice_due` (own filter toggle — row volume),
`bulk_eta`, `goal_due`, `campaign_window`, `shopify_payouts`; add
`?request=` deep link to request_manager and `?date=` to live-schedule;
add `reviews.period_start/end`; migrate Travel into Supabase (new
`travel_requests` table) then project it.

**Phase D (surfaces):** dashboard "Upcoming" widget on finance.html/profile
feed re-pointed at `calendar_events_v`; agenda absorb of profile attention
feed; conflict detection (launch vs PO arrival, payment+payroll same day) as
a `compute_silo_calendar_warnings()` sibling of the insights engine; iCal
feed (already on the launch workbench wishlist); notifications via the
existing edge-function + Resend pattern.

## 10. Risks & mitigations

- **Leaks via the calendar** — killed structurally: `security_invoker` + no
  SECURITY DEFINER anywhere in the read path. The one soft spot inherited
  from today: AR/payroll dept-hiding on *legacy* pages is client-side; the
  calendar only projects payroll (DB-gated) and defers AR.
- **Duplicates** — one canonical source per event type; the view is the only
  projector. Launch dates come from `launch_calendar` only (product_tracker
  and readiness reference it, they don't emit events).
- **Stale data** — impossible by construction (projection, not copies).
  Deleted source rows vanish from the calendar automatically.
- **Timezones** — all-day = plain date everywhere; timed events limited to
  the one timestamptz source, converted in exactly one place (§4).
- **Company-ID inconsistency** — the view exposes `company_entity_id` and the
  page uses the standard conditional `.eq()` + `ensureActiveCompany()`
  self-heal; RLS remains the backstop.
- **Row volume** — range-bounded queries only; indexes on every projected
  date column; AR (the one high-volume source) deferred behind its own
  toggle.
- **Legacy/V2 mismatch** — Sheets/localStorage tools (travel, checkwriter,
  recon, allocation) are excluded until they have real tables; nothing
  pretends to project them.
- **Migration conflict flag (pre-existing, noted during audit):**
  `reviews_can_manage()` has two competing definitions
  (`20260804000000` self-service vs `20260714210000` role-gated). Not
  calendar-related; verify which won in prod.
- **Orphan flag:** `incoming_shipments` has RLS policies but no CREATE TABLE
  in-repo and zero app references (it exists in the live DB with ship/eta
  dates). If it ever goes live, it's a natural `po_arrival` refinement.

---

## What shipped in V1 (this branch)

- `supabase/migrations/20260810120000_org_calendar.sql` — `calendar_events`
  table + RLS + triggers + indexes, `calendar_events_v` projection view,
  source-date indexes. Idempotent; appended to `apply_all_post_merge.sql`;
  checks added to `verify_v2_schema.sql` (§20 in that file).
- `/v2/calendar.html` — Org Calendar (month + agenda, filters, drawer,
  manual-event CRUD).
- Nav: `planning/calendar` in `nav-config.js`; Planning card link on
  `finance.html`.

After applying the migration, run `supabase/verify_v2_schema.sql` — all rows
must show `ok`.
