-- Make a stalled feed visible inside SILO, to people and to bots.
--
-- THE GAP. scripts/reconcile-integrations.mjs already answers, every morning
-- at 15:00 UTC, the only question that matters here: for every connection in
-- every company, across the nine feeds in lib/integration-reconcile-core.mjs,
-- has its authorisation expired, has it ever produced anything, and is what it
-- produced recent enough. Its verdicts then go to a workflow log and a step
-- summary and nowhere else. Nothing in SILO shows them, no report returns them,
-- and the connection tables they are derived from are `is_hidden` in the chat
-- catalog, so a connected AI cannot reach them at all. That is why Baseballism
-- Operating's Plaid feed sat stalled from 2026-10-26 for eight days with every
-- sync green: the knowledge existed and had nowhere to land.
--
-- WHY THIS SHAPE. The judgement is NOT re-derived in SQL. Which stamp each feed
-- is judged on is hard-won and counter-intuitive -- `sales_by_day`'s newest day
-- is not freshness, because a store with no orders since March syncs fine every
-- morning and ten of production's stores look like that; inventory holds one
-- overwritten snapshot, so the table's own watermark IS the attempt; a
-- webhook-driven feed like Redo is never judged on lag at all, because a store
-- with no returns is not broken. Encoding that a second time in a view would
-- give two sources of truth that drift. So the reconciler persists what it
-- already computes, one row per (company, feed, connection), and this migration
-- is the place it lands plus the surfaces that read it.
--
-- THE HEALTH DATA CAN ITSELF GO STALE, which is the failure that would make
-- this surface a liar: if the workflow stops, the last verdicts sit there
-- looking like news. So `observed_at` is a column, the view exposes
-- `observed_hours_ago` and `observation_stale` (over 36 hours, against a daily
-- run), and the report's second tie-out compares rows observed in the last 48
-- hours against all rows -- so report-tieouts-nightly goes red when the
-- reconciler stops running, which is exactly the alarm that was missing.
--
-- NOT IN SCOPE. The reconciler's behaviour is unchanged otherwise: it still
-- queues a first import only under RECONCILE_AUTO_START, never enables a sync,
-- never edits a connection and never touches client data. Writing health rows
-- is additive and happens whether or not auto-start is on.
--
-- Also here, because both are corrections to 20261103190000 and belong with the
-- surface that replaces them:
--   * The four dated staleness notes come out. A catalog row is global across
--     tenants and nothing updates it when a feed resumes, so "payroll answers
--     are historic" rots silently and misleads the day after the next import
--     (Blake, 2026-11-03: "no don't confuse future"). Each description now says
--     WHERE to check coverage -- this view, or the table's own watermark -- and
--     states no date. Point-in-time row counts and the dated enum snapshot go
--     for the same reason.
--   * silo_ledger_lines_v no longer calls itself the books. It holds activity
--     SILO recorded: no accepted opening balance, and nothing entered directly
--     in QuickBooks. An account balance computed from it alone is understated
--     by both, which is precisely the mistake v2/accounting-ledger.js keeps
--     three columns apart to avoid. Raised as a P2 on #1106.

begin;

-- ── 1. Where the reconciler's verdicts land ────────────────────────────────
create table if not exists public.integration_feed_health (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid not null,
  feed              text not null,
  connection_id     uuid,
  connection_label  text,
  integration       text,
  state             text not null,
  severity          text not null,
  detail            text,
  coverage          text,
  lag_days          integer,
  tolerance_days    integer,
  measured_through  text,
  expires_in_days   integer,
  event_driven      boolean not null default false,
  observed_at       timestamptz not null default now(),
  constraint integration_feed_health_severity_check
    check (severity in ('ok', 'warn', 'action')),
  -- Current state, not history: one row per connection per feed, replaced each
  -- run. The reconciler always names the connection its verdict was formed
  -- about, so connection_id is in practice never null; `nulls not distinct`
  -- is the backstop, because under the default NULL semantics a row that did
  -- arrive without one would be inserted again on every run for ever instead
  -- of being replaced.
  constraint integration_feed_health_identity
    unique nulls not distinct (company_entity_id, feed, connection_id)
);

comment on table public.integration_feed_health is
  'Current per-feed health as scripts/reconcile-integrations.mjs last judged it: one row per (company, feed, connection), replaced on each daily run. observed_at is when that verdict was formed -- a row older than about a day means the reconciler itself has stopped, not that the feed is fine. Written by service_role only. 20261103220000.';

alter table public.integration_feed_health enable row level security;

-- Read-only for signed-in users, scoped to the active company, which is the
-- same boundary every operational table uses. No insert/update/delete policy:
-- the reconciler writes with the service role, and nothing in the browser or
-- through an integration token may write a verdict.
drop policy if exists integration_feed_health_select on public.integration_feed_health;
create policy integration_feed_health_select on public.integration_feed_health
  for select using (company_entity_id = public.active_company_id());

revoke all on public.integration_feed_health from anon, authenticated;
grant select on public.integration_feed_health to authenticated;

create index if not exists integration_feed_health_company_idx
  on public.integration_feed_health (company_entity_id, severity, feed);

-- ── 2. The view people and bots read ───────────────────────────────────────
-- security_invoker, so RLS above is the boundary through it. The connection
-- tables this is derived from are is_hidden in the chat catalog, so for a
-- connected AI this view is the ONLY way to see whether a feed is arriving.
create or replace view public.silo_feed_health_v
with (security_invoker = true) as
select h.company_entity_id,
       h.feed,
       h.integration,
       h.connection_id,
       h.connection_label,
       h.state,
       h.severity,
       h.detail,
       h.coverage,
       h.lag_days,
       h.tolerance_days,
       h.measured_through,
       h.expires_in_days,
       h.event_driven,
       h.observed_at,
       (extract(epoch from (now() - h.observed_at)) / 3600.0)::numeric(10, 1) as observed_hours_ago,
       (now() - h.observed_at) > interval '36 hours' as observation_stale
  from public.integration_feed_health h;

comment on view public.silo_feed_health_v is
  'Per-feed health for the active company, as the daily reconciler last judged it, plus how old that judgement is. observation_stale means the reconciler has not run in over 36 hours, so every verdict here is unconfirmed. 20261103220000.';

grant select on public.silo_feed_health_v to authenticated;

commit;

-- ── 3. What the model is told about the new surface ────────────────────────
begin;

-- The catalog's rows are generated from pg_class, so the two new relations have
-- none yet and every update below would no-op silently. Refresh first, then
-- fail loudly if they are still absent.
select public.refresh_chat_schema_catalog();

do $$
begin
  if not exists (select 1 from public.silo_chat_schema_catalog
                  where relname in ('silo_feed_health_v', 'integration_feed_health')
                  having count(*) = 2) then
    raise exception 'the catalog does not hold both feed-health relations after a refresh';
  end if;
end $$;

update public.silo_chat_schema_catalog set
  keywords = array['freshness','stale','sync','data health','last sync','up to date',
                   'feed','integration','coverage','is the data current','missing data'],
  description = $d$WHETHER EACH FEED IS ACTUALLY ARRIVING -- read this before concluding that data is missing. One row per feed per connection for the company, as the daily reconciler last judged it: state and severity ('ok', 'warn', 'action'), a detail line in words, lag_days against tolerance_days, coverage, and expires_in_days for an authorisation about to lapse. BLANK IS NOT ZERO, and this is how to tell which: a feed reading 'stale', 'never_imported', 'synced_but_empty' or 'expired' means the rows you are missing were never delivered, so say the sync is behind rather than reporting a decline. CHECK observation_stale AND observed_hours_ago FIRST: the verdicts are formed once a day, and if the reconciler itself has stopped, observation_stale is true and nothing here is confirmed. event_driven feeds (returns, for one) are never judged on lag, because no rows is a normal business state for them. The connection tables behind this are hidden from you, so this view is the only way to see it.$d$,
  updated_at = now()
where relname = 'silo_feed_health_v';

update public.silo_chat_schema_catalog set
  keywords = array['feed health','freshness','sync status','stale','integration health','data health'],
  description = $d$The table behind silo_feed_health_v -- read the view, which adds how old each verdict is. One row per (company, feed, connection), replaced on every run of the daily reconciler; observed_at is when the verdict was formed, not when the data arrived.$d$,
  updated_at = now()
where relname = 'integration_feed_health';

-- ── 4. The dated staleness notes come out ──────────────────────────────────
-- Unconditional, unlike 20261103190000's seed, which only wrote a description
-- where none existed: these rows have one and it is the thing being corrected.
-- Setting a known text is idempotent by nature.
update public.silo_chat_schema_catalog set
  description = $d$Which QuickBooks account SILO posts a given kind of thing to. One row per map_key per company, resolving to qbo_account_id / qbo_account_name. Configuration behind the posting logic, not transactions -- a small mapping table, so do not mistake it for a chart of accounts (that is accounting_accounts).$d$,
  updated_at = now()
where relname = 'accounting_coa_map';

update public.silo_chat_schema_catalog set
  description = $d$One row per wholesale customer with their AR position rolled up. Columns: current_open_balance, open_invoice_count, oldest_open_invoice_date, the aging ladder (current_amount, aging_1_30, aging_31_60, aging_61_90, aging_90_plus), total_sales, order counts and the collections workflow fields. The customer-level answer; ar_invoices is the invoice-level one. Same coverage rule as ar_invoices: read max(last_seen_at) before quoting a balance and name that as-of day.$d$,
  updated_at = now()
where relname = 'ar_customer_rollup_v';

update public.silo_chat_schema_catalog set
  description = $d$The collections working view: ar_invoices with the customer's contact and workflow fields joined on. Columns: (effective_customer_name, effective_email, effective_term_days, contact_status, preferred_channel, workflow_priority, assigned_to, last_contacted_at, next_follow_up_at). The collections working view. Inherits ar_invoices' coverage: read max(last_seen_at) before quoting a balance and name that as-of day.$d$,
  updated_at = now()
where relname = 'ar_invoice_workbench_v';

update public.silo_chat_schema_catalog set
  description = $d$Wholesale accounts receivable, one row per invoice or order from the AR sync. Columns: order_date, due_date, term_days, the amount breakdown (gross, discounts, refunds, shipping, taxes, sales_amount, open_amount, paid_amount), days_past_due, aging_bucket ('current', '1-30', '31-60', '61-90', '90+', 'paid'), settlement_class ('open', 'closed', 'paid') and is_open. COVERAGE: the AR sync is per company and can be switched off, in which case these rows stop at the day it last ran. Read max(last_seen_at) before quoting a balance, name that as-of day in the answer, and bear in mind open AR may be maintained on the Wholesale Tracking dashboard instead. Prefer ar_invoice_workbench_v, which adds the customer's workflow fields.$d$,
  updated_at = now()
where relname = 'ar_invoices';

update public.silo_chat_schema_catalog set
  description = $d$Daily Instagram account reach per day_date. Reach is the ONLY metric Meta returns at account level here, so impressions, profile views and follower counts are absent rather than zero; the series begins when the connection was made, so check which days are present before reading a trend.$d$,
  updated_at = now()
where relname = 'instagram_account_insights_daily';

update public.silo_chat_schema_catalog set
  description = $d$Payroll by department and location within a pay period. Columns: employee_count, total_hours, total_payroll_amount, gross_earnings, net_pay, employee_tax, employer_tax and the time-allocation split (time_hours, register_hours, time_allocation_amount). Same coverage rule as payroll_register_lines: check the newest pay period present before concluding anything is missing.$d$,
  updated_at = now()
where relname = 'payroll_department_cost_v';

update public.silo_chat_schema_catalog set
  description = $d$Payroll by employee within a pay period. Columns: gross_earnings, net_pay, employee_tax, employer_tax, total_hours and total_payroll_amount per ee_code per batch, with the pay period and check_date. Employee-level pay is sensitive; RLS is narrow by design. Same coverage rule as payroll_register_lines: check the newest pay period present before concluding anything is missing.$d$,
  updated_at = now()
where relname = 'payroll_employee_cost_v';

update public.silo_chat_schema_catalog set
  description = $d$Imported payroll register detail, one row per employee per pay type per batch. Columns: (ee_code / ee_name, typecode / typedesc, register_type, amount, hours_units, wages, department and location codes, pay_period_start..pay_period_end). An adjusted row keeps its original_amount / original_hours_units / original_wages beside the corrected values, so summing both columns double counts. COVERAGE IS NOT CONTINUOUS: payroll arrives by import, and imports stop and start. Read max(pay_period_end) for the company before answering a period question, and call an absent period NOT IMPORTED rather than zero -- silo_feed_health_v carries the same judgement for the feeds SILO syncs itself. Totals are easier from payroll_register_monthly_v, payroll_employee_cost_v and payroll_department_cost_v.$d$,
  updated_at = now()
where relname = 'payroll_register_lines';

update public.silo_chat_schema_catalog set
  description = $d$Payroll by month, and the month-level answer for what payroll costs. Columns: employee_count, register_hours, gross_wages, employer_taxes, payroll_expense, net_pay, ee_taxes, deductions and wage_rate per month_start. The month-level answer for "what does payroll cost". Covers only the months imported into payroll_register_lines, so read the newest month present before answering a recent-month question and call an absent month not imported rather than zero.$d$,
  updated_at = now()
where relname = 'payroll_register_monthly_v';

update public.silo_chat_schema_catalog set
  description = $d$The sample tracker, one row per sample. Columns: sample_ref, product_title, factory_name, product_type, collection, bulk_eta, the per-stage dates (sent_at, received_at, warehouse_ready_at, picked_up_at, photo_received_at) and sample_status -- values seen include 'pps_received', 'received', 'full_run_received', 'warehouse_ready' and 'picked_up', and it is not a closed list. size_requests, sizes_ready_warehouse and sizes_picked_up are the size-level detail, and photo_status / copy_status / live_status track the content work. Links to its launch and PO.$d$,
  updated_at = now()
where relname = 'product_samples_v';

update public.silo_chat_schema_catalog set
  description = $d$The merchandising tag sheet per product_title. Columns: product_category, collection, type, primary_color, artwork_side, tag and sub_tag, indicator_group, and a current_inventory column that came in with the upload. UPLOADED IN BULK: current_inventory is whatever the spreadsheet said when it was uploaded, NOT live stock -- read uploaded_at before treating any of it as current, and use inventory_workboard_v for on-hand. The tags themselves are still the merchandising taxonomy.$d$,
  updated_at = now()
where relname = 'product_tags';

update public.silo_chat_schema_catalog set
  description = $d$The audit trail of revenue_projections, one row per change. It carries action_type, changed_at, changed_by and the projected_units / projected_sales as of that change. HISTORY, NOT THE PLAN -- the current projection is in revenue_projections. Projections are written by hand, so they are only as current as their updated_at: read it and date any answer.$d$,
  updated_at = now()
where relname = 'revenue_projection_history';

update public.silo_chat_schema_catalog set
  description = $d$Prepaid and amortization schedules, one row per item being spread over time. Columns: schedule_type, label, vendor_name, the service_start..service_end window, method and status, optionally linked to the payment_request it came from. Observed values are schedule_type 'prepaid' and method 'straight_line'. SMALL BY DESIGN: a company may carry only a handful of schedules, so an empty-looking answer here is an empty schedule rather than a broken feed. Balances are in schedule_item_balances_v and the per-period split in schedule_item_amortization_v.$d$,
  updated_at = now()
where relname = 'schedule_items';

-- 'trial balance' STAYS in this view's keywords, deliberately. The review that
-- found this wording read the keyword as a claim; it is a ranking signal, and a
-- trial-balance question is exactly the question that must land on the warning
-- below and be sent to the three sources that do answer it. Removing it would
-- hide the correction from the question it exists for.
update public.silo_chat_schema_catalog set
  description = $d$SILO's recorded ledger activity, flattened for reporting. Every ledger line with its entry's date, kind, source and memo, plus signed_amount (credits negative, so it sums straight) and in_quickbooks / quickbooks_date for whether that line has been posted to QuickBooks. THIS IS ACTIVITY SILO RECORDED, NOT THE BOOKS: it holds no accepted opening balance and nothing entered directly in QuickBooks (bills, payments, payroll, deposits), so an account BALANCE or a trial balance computed from it alone is understated by both. For a balance, do what the Accounting ledger tab does and keep three sources apart -- the accepted opening snapshot (accounting_opening_balances), SILO's own activity (this view), and a saved QuickBooks trial balance (quickbooks_report_runs) -- where opening + activity = closing and the remainder is everything QuickBooks holds that SILO did not originate. Use this view for what SILO recorded and for what has or has not reached QuickBooks. batch_id, transaction_id, adjustment_id and posting_id point back at the card batch, card transaction or journal adjustment behind the line.$d$,
  updated_at = now()
where relname = 'silo_ledger_lines_v';

commit;

-- ── 5. The "Data freshness" SILO report ────────────────────────────────────
-- A system report, so it needs no new tool, scope or path: the MCP's
-- run_report, the API's silo_api_run_report, Ask SILO and every dashboard tile
-- already run any `source = 'system'` report. Rows are whatever RLS shows that
-- person in their company, which for this view means their own company's feeds.
begin;

insert into public.silo_chat_saved_reports
  (id, company_entity_id, created_by, source, visibility, title, description, question, answer,
   queries_run, parameters, columns_metadata)
values
  ('c8000000-0000-4000-a000-000000000001', null, null, 'system', 'company',
   'Data freshness',
   'Whether each of this company''s data feeds is actually arriving: one row per feed per connection, with its state, how far behind it is against the tolerance for that feed, and a plain-words detail line. Read it before concluding that data is missing -- a feed reading stale, never_imported, synced_but_empty or expired means rows were never delivered, which is not a decline. observation_hours_ago and observation_stale say how old the judgement itself is: the verdicts are formed once a day, and if that run has stopped nothing here is confirmed. Feeds marked event_driven are never judged on lag, because having no rows is normal for them.',
   null, null,
   array[$q$select h.feed,
       coalesce(h.integration, h.feed) as integration,
       coalesce(h.connection_label, 'company-wide') as connection,
       h.state,
       h.severity,
       h.detail,
       h.lag_days,
       h.tolerance_days,
       h.measured_through,
       h.expires_in_days,
       h.event_driven,
       h.observed_at,
       h.observed_hours_ago,
       h.observation_stale,
       'https://get-silo.com/v2/setup-checklist.html' as open_in_silo
  from public.silo_feed_health_v h
 order by case h.severity when 'action' then 0 when 'warn' then 1 else 2 end,
          h.feed,
          coalesce(h.connection_label, '')$q$],
   '[]'::jsonb,
   '{"feed":{"label":"Feed","source":"authored"},
     "integration":{"label":"Integration","source":"authored"},
     "connection":{"label":"Connection","source":"authored"},
     "state":{"label":"State","source":"authored"},
     "severity":{"label":"Severity","source":"authored"},
     "detail":{"label":"What is wrong","source":"authored"},
     "lag_days":{"label":"Days behind","semantic":"count","source":"authored"},
     "tolerance_days":{"label":"Tolerance (days)","semantic":"count","source":"authored"},
     "measured_through":{"label":"Measured through","source":"authored"},
     "expires_in_days":{"label":"Auth expires in (days)","semantic":"count","source":"authored"},
     "event_driven":{"label":"Event driven","source":"authored"},
     "observed_at":{"label":"Judged at","semantic":"date","source":"authored"},
     "observed_hours_ago":{"label":"Judgement age (hours)","semantic":"count","source":"authored"},
     "observation_stale":{"label":"Judgement stale","source":"authored"},
     "open_in_silo":{"label":"Open in SILO","semantic":"link","source":"authored"}}'::jsonb)
on conflict (id) do update set
  title = excluded.title, description = excluded.description,
  queries_run = excluded.queries_run, parameters = excluded.parameters,
  columns_metadata = excluded.columns_metadata,
  archived_at = null, updated_at = now();

-- Tie-outs. The first is the ordinary row-count reconciliation every system
-- report carries. The second is the point of this migration: it compares rows
-- judged in the last 48 hours against all rows, so if the reconciler stops
-- running, report-tieouts-nightly turns red -- a stalled freshness surface
-- announcing itself rather than quietly serving yesterday's verdicts.
do $$
declare
  r      record;
  guard  text;
  note   constant text := 'Counts the base table directly. NO DATA means the report changed and this check must be regenerated in the same migration.';
begin
  select * into r from public.silo_chat_saved_reports
   where id = 'c8000000-0000-4000-a000-000000000001'
     and source = 'system' and company_entity_id is null;
  if r.id is null then
    raise exception 'the Data freshness report was not inserted';
  end if;

  guard := format('(select md5(queries_run::text || parameters::text) = %L from public.silo_chat_saved_reports where id = %L)',
                  md5(r.queries_run::text || r.parameters::text), r.id);
  delete from public.silo_report_tieouts where report_id = r.id;

  insert into public.silo_report_tieouts (report_id, name, kind, check_sql, tolerance, note) values
  (r.id, 'Every feed judged for this company is reported', 'reconciliation',
   format('with report as materialized (%s) select case when %s then count(*) end as left_value, '
     || '(select count(*) from public.integration_feed_health h where h.company_entity_id = (select public.active_company_id())) as right_value from report',
     r.queries_run[1], guard), 0, note),
  (r.id, 'Every verdict was formed in the last 48 hours', 'sanity',
   format('with report as materialized (%s) select case when %s then count(*) filter (where observed_at > now() - interval ''48 hours'') end as left_value, '
     || '(select count(*) from public.integration_feed_health h where h.company_entity_id = (select public.active_company_id())) as right_value from report',
     r.queries_run[1], guard), 0,
   'Red means scripts/reconcile-integrations.mjs has not run, so every freshness verdict in SILO is older than a day and unconfirmed. Check the Integration reconcile workflow before trusting the report.');
end $$;

commit;

select public.attach_stamp_company_entity_id_triggers();
