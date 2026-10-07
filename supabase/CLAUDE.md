# supabase/ — database rules

Loaded when you work in `supabase/`. Table-by-table invariants, every gate function and RPC:
[`docs/agents/database.md`](../docs/agents/database.md). **Read the row for any table you touch** —
most carry a decision that looks like a bug and is not.

## Before you write SQL
- Read live definitions: `pg_policy`, `pg_constraint`, `pg_trigger` / `pg_get_functiondef`,
  `has_function_privilege`. Migration files are not the live state: some triggers and functions were
  applied by hand and exist in no migration.
- Supabase's default privileges re-grant EXECUTE on every new `public` function to `anon` and
  `authenticated`. Revoke explicitly from BOTH whenever a function must not be client-callable. A
  `create or replace` keeps the existing grants.

## New table or migration
1. `supabase/migrations/YYYYMMDDHHMMSS_description.sql`, idempotent (`if not exists`, `create or replace`).
2. `alter table ... enable row level security` plus policies. Company-scoped tables filter on
   `company_entity_id = active_company_id()`.
3. If it has `company_entity_id`, end with `select public.attach_stamp_company_entity_id_triggers();`
   (the insert backstop; not automatic — verify check 6 fails without it).
4. Add it to `verify_v2_schema.sql`, `apply_all_post_merge.sql` and `README.md`.
5. After any public table/view change, re-run `refresh_chat_schema_catalog()` (Ask SILO's map).
6. Production changes (applying a migration, running SQL that writes) need Blake's explicit approval
   in the session. If one was applied directly with that approval, open the PR in the same session.
7. `20260922170000` must stay the LAST include in `apply_all_post_merge.sql`.

## Rules that have each caused a real incident
- **Views: `security_invoker = true` by default.** Use `security_invoker = false` ONLY for a wrapper
  that must read something RLS cannot cover (a matview, or a rollup too slow under the caller's RLS),
  and then the view MUST filter `company_entity_id = active_company_id()` and expose only the columns
  it means to disclose. Production's ten such wrappers (2026-10-07): `inventory_on_hand_current_v`,
  `sales_velocity_by_sku_location_v`, `sales_by_product_title_daily_v`,
  `sales_monthly_product_type_rollup_v`, `wow_sales_daily_type_v`, `search_console_query_rollup_v`,
  `search_console_query_rollup_28d_v`, `demand_coverage_base_v`, `product_type_forecastable_v`,
  `stripe_connect_status_v`. One more, `ar_sync_status_v`, is definer with NO company filter and is
  readable by `anon` — a known gap, not a pattern to copy.
- **Materialized views have no RLS.** Read them only through their wrapper view (above). Never grant a matview to
  `authenticated`, and never point a global (`source = 'system'`) report at a matview.
- **`chat_run_readonly_query` returns `json`, not `jsonb`** — jsonb reorders columns. Leave it.
- **Business days:** use `silo_business_today()` / `_yesterday()` / `silo_company_timezone()`, never
  `current_date`. `'America/Los_Angeles'` may appear only in `silo_company_timezone()` (verify enforces).
- **Channels:** `location_tag = any((select silo_channel_location_tags('online'))::text[])` — hoisted,
  with the cast. Never the literal `'online'` (verify enforces). An empty channel means "not
  configured", never $0.
- **Sales by product:** join through `sales_by_product_title_daily_v`; never group by
  `sales_by_day.product_name`.
- **Inventory velocity:** check `inventory_workboard_v.velocity_matched` before trusting a quantity.
- **NULL means not measured, never zero** — across Search Console, SERP, Shopify payment terms, Meta
  creatives and row estimates. Do not coalesce these to 0.
- **Ratios are pooled from their parts, never averaged.**
- **Storage:** private bucket paths start with the PARENT row's id, and the policy is an `EXISTS` on the
  parent table. Do not copy another bucket's policy body.
- **An RLS-refused UPDATE succeeds with zero rows**, it does not error. Handle that case by name.
- **A SILO report edit must regenerate its tie-outs in the same migration**, or the nightly tie-out run
  goes red.
- **Every `system` report needs a `silo_report_tieouts` reconciliation**; `run_report_tieouts()` checks
  them.
- `inventory_on_hand` holds one snapshot. Do not remove the purge to get history. Do not re-"optimise"
  `inventory_workboard_v`; it already reads matviews through their wrappers.
- **Marketing revenue:** platform `conversion_value` is what an ad platform CLAIMS, not sales, and the
  platforms overlap. Never present it as revenue next to Shopify sales without naming which is which.
- **Search Console:** site, page and query are three grains in three tables, never joined into one
  figure. Query rows are partial by construction. A missing page row means "not returned", not zero.
- **Money and the ledger:** card split lines must total the transaction to the cent, and split RULES
  never store amounts. `quickbooks-post-journal` is the only write path to QuickBooks, and it posts only
  from a finance-approved, hashed snapshot. Posted rows are immutable; a change is a void or reversal.
  `ledger_entries` is append-only.
- **AI credit pricing** (rates, multiplier, packs, `mode`) is configured at rollout and is never
  committed to the repo.
- `authenticated` has an 8s statement timeout, and `SET LOCAL` inside a function cannot raise it for the
  running statement. Size browser-facing queries to 8s.

## After any DB change
Run `verify_v2_schema.sql` (all rows `ok`). The drift check runs it on production daily and on every
push to `main` under `supabase/`.
