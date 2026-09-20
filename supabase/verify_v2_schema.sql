-- =============================================================================
-- SILO schema check (run in Supabase SQL Editor after migrations)
-- All "ok" rows should show status = 'ok'. Anything "missing" needs apply SQL.
-- =============================================================================

-- 1. Core tables, views, functions
with expected as (
  select * from (values
    ('table',   'factories'),
    ('table',   'po_headers'),
    ('table',   'po_lines'),
    ('table',   'po_costing'),
    ('table',   'po_costing_lines'),
    ('view',    'v_po_header_summary'),
    ('view',    'v_po_costing_summary'),
    ('view',    'v_po_sku_prior_cost'),
    ('routine', 'generate_next_po_name'),
    ('routine', 'next_location_id'),
    ('routine', 'po_builder_can_write'),
    ('routine', 'po_costing_can_write')
  ) as t(kind, name)
),
found as (
  select 'table' as kind, c.relname as name
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'v')
  union all
  select 'view', c.relname
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'v'
  union all
  select 'routine', proname
  from pg_proc
  join pg_namespace n on n.oid = pg_proc.pronamespace
  where n.nspname = 'public'
)
select
  e.kind,
  e.name,
  case when f.name is not null then 'ok' else 'MISSING — run supabase/apply_all_post_merge.sql' end as status
from expected e
left join found f on f.kind = e.kind and f.name = e.name
order by e.kind, e.name;

-- 2. Profile policies (needed for /v2/profile.html)
select
  want.polname as policy_name,
  case when pol.policyname is not null then 'ok' else 'MISSING — run section 3 in apply_all_post_merge.sql' end as status
-- Renamed by 20260913054723: profiles_select_own/profiles_update_own were
-- replaced by the company-scoped read policy and the self-only write policy.
from (values ('profiles_select_active_company'), ('profiles_update_self')) as want(polname)
left join pg_policies pol
  on pol.schemaname = 'public'
 and pol.tablename = 'profiles'
 and pol.policyname = want.polname;

-- 3. Launch comment author columns (migrations 20260603120000 + 20260603130000)
select
  col.column_name,
  case when col.column_name is not null then 'ok' else 'MISSING — run launch_comments_author migrations' end as status
from (values ('user_id'), ('author_name'), ('author_email')) as want(column_name)
left join information_schema.columns col
  on col.table_schema = 'public'
 and col.table_name = 'launch_comments'
 and col.column_name = want.column_name;

-- 4. Product tracker table (migration 20260604000000)
select
  col.column_name,
  case when col.column_name is not null then 'ok' else 'MISSING — run section 12 in apply_all_post_merge.sql' end as status
from (values ('id'),('product_title'),('launch_id'),('photo_complete'),('is_live')) as want(column_name)
left join information_schema.columns col
  on col.table_schema = 'public'
 and col.table_name = 'product_tracker'
 and col.column_name = want.column_name;

-- 5. Payment requests legacy import columns (migration 20260609000000)
select
  col.column_name,
  case when col.column_name is not null then 'ok' else 'MISSING — run 20260609000000_payment_requests_legacy_import.sql' end as status
from (values ('legacy_source'), ('legacy_url'), ('legacy_external_id'), ('imported_at')) as want(column_name)
left join information_schema.columns col
  on col.table_schema = 'public'
 and col.table_name = 'payment_requests'
 and col.column_name = want.column_name;

-- 6. Insert stamp (migration 20260616060000)
select
  want.name,
  case when f.proname is not null then 'ok' else 'MISSING — run 20260616060000_stamp_company_entity_id_on_insert.sql' end as status
from (values ('stamp_company_entity_id'), ('attach_stamp_company_entity_id_triggers')) as want(name)
left join pg_proc f
  on f.proname = want.name
left join pg_namespace n on n.oid = f.pronamespace and n.nspname = 'public';

-- An ANTI-JOIN, not a count comparison. The previous version compared a COUNT
-- of triggers against a COUNT of required tables, and the two were counted
-- over different sets: the denominator excluded seven tables while the
-- numerator counted triggers on all of them. Five of those seven -- the four
-- plaid_* and finance_audit_events -- do carry the trigger, so the numerator
-- sat five ahead permanently and one through five required tables could lose
-- their trigger with this still reading 'ok'. Measured on production
-- 2026-09-20: 169 vs 164, slack 5. That is why 20260919140000's SIX missing
-- tables were caught and five would not have been -- a check that only fires
-- past a threshold of six is credited as coverage it does not provide.
--
-- Each required table is now tested on its own, and the failure NAMES them,
-- because "MISSING" with no list sends the next person to count triggers by
-- hand. The binding is checked too, not just the name: a trigger called
-- stamp_company_entity_id that points somewhere else is exactly what a
-- name-only test waves through.
with required as (
  select c.table_name
  from information_schema.columns c
  join information_schema.tables t
    on t.table_schema = c.table_schema and t.table_name = c.table_name
  where c.table_schema = 'public'
    and c.column_name = 'company_entity_id'
    and t.table_type = 'BASE TABLE'
    -- Service-owned finance records require explicit NOT NULL companies.
    -- This set is deliberately WIDER than attach_stamp_company_entity_id_triggers()'s
    -- own exclusions (which are only inventory_on_hand / sales_by_day): the
    -- helper still maintains a trigger on these five if one goes missing, this
    -- check simply does not require it. Unifying the two sets would either
    -- stop maintaining them or start requiring them -- a decision about
    -- service-owned finance records, not a tidy-up.
    and c.table_name not in ('inventory_on_hand','sales_by_day','plaid_connections','plaid_connection_secrets','plaid_accounts','plaid_sync_exceptions','finance_audit_events')
),
missing as (
  select r.table_name
  from required r
  where not exists (
    select 1
    from pg_trigger tg
    join pg_class cl on cl.oid = tg.tgrelid
    join pg_namespace n on n.oid = cl.relnamespace
    where n.nspname = 'public'
      and cl.relname = r.table_name
      and tg.tgname = 'stamp_company_entity_id'
      and not tg.tgisinternal
      and tg.tgfoid = 'public.stamp_company_entity_id()'::regprocedure
      -- 'O' origin (default) or 'A' always. NOT `<> 'D'`, which also accepts
      -- 'R': a replica-only trigger does not fire for ordinary application
      -- inserts, so the backstop would be off while this read 'ok'.
      and tg.tgenabled in ('O', 'A')
      -- EXACTLY ROW|BEFORE|INSERT. A bitwise `& 4` test requires INSERT
      -- without rejecting UPDATE/DELETE/TRUNCATE/INSTEAD, so BEFORE INSERT OR
      -- UPDATE would pass -- and that re-stamps a cleared company on UPDATE.
      and tg.tgtype = 7
  )
)
select
  (select count(*) from required)::int as required_tables,
  case
    when not exists (select 1 from missing) then 'ok'
    else 'MISSING — run attach_stamp_company_entity_id_triggers(); no stamp trigger on: '
         || (select string_agg(table_name, ', ' order by table_name) from missing)
  end as status;

-- 7. Shopify integration tables
select
  case when exists (select 1 from information_schema.tables where table_schema='public' and table_name='shopify_connections') then 'ok' else 'MISSING' end as shopify_connections,
  case when exists (select 1 from information_schema.tables where table_schema='public' and table_name='sync_jobs') then 'ok' else 'MISSING' end as sync_jobs,
  case when exists (select 1 from information_schema.columns where table_schema='public' and table_name='locations' and column_name='shopify_location_id') then 'ok' else 'MISSING' end as locations_shopify_location_id;

-- 7b. Ad platform direct-API tables (20260807000000_ad_platform_direct_api.sql)
select
  case when exists (select 1 from information_schema.tables where table_schema='public' and table_name='ad_platform_connections') then 'ok' else 'MISSING' end as ad_platform_connections,
  case when exists (select 1 from information_schema.tables where table_schema='public' and table_name='ad_platform_oauth_states') then 'ok' else 'MISSING' end as ad_platform_oauth_states,
  case when exists (select 1 from information_schema.tables where table_schema='public' and table_name='marketing_kpis_daily') then 'ok' else 'MISSING' end as marketing_kpis_daily,
  case when not exists (select 1 from information_schema.tables where table_schema='public' and table_name='supermetrics_connections') then 'ok' else 'STILL PRESENT' end as supermetrics_connections_dropped,
  case when exists (select 1 from pg_constraint where conname='sync_jobs_job_type_check' and pg_get_constraintdef(oid) like '%google_ads_kpis%') then 'ok' else 'MISSING' end as sync_jobs_ad_platform_types,
  case when exists (select 1 from information_schema.views where table_schema='public' and table_name='v_marketing_mer_daily') then 'ok' else 'MISSING' end as v_marketing_mer_daily,
  case when exists (select 1 from information_schema.tables where table_schema='public' and table_name='meta_ad_performance_daily') then 'ok' else 'MISSING' end as meta_ad_performance_daily,
  case when exists (select 1 from information_schema.tables where table_schema='public' and table_name='meta_ad_creatives') then 'ok' else 'MISSING' end as meta_ad_creatives,
  case when exists (select 1 from information_schema.columns where table_schema='public' and table_name='marketing_kpis_daily' and column_name='view_content') then 'ok' else 'MISSING' end as meta_funnel_events_columns,
  case when exists (select 1 from information_schema.tables where table_schema='public' and table_name='instagram_media_insights') then 'ok' else 'MISSING' end as instagram_media_insights,
  case when exists (select 1 from information_schema.tables where table_schema='public' and table_name='facebook_page_insights_daily') then 'ok' else 'MISSING' end as facebook_page_insights_daily;

-- 7d. Redo returns integration (20260812120000_redo_returns_integration.sql)
select
  case when exists (select 1 from information_schema.tables where table_schema='public' and table_name='redo_connections') then 'ok' else 'MISSING' end as redo_connections,
  case when exists (select 1 from information_schema.tables where table_schema='public' and table_name='redo_returns') then 'ok' else 'MISSING' end as redo_returns,
  case when exists (select 1 from pg_indexes where schemaname='public' and tablename='redo_returns' and indexname='idx_redo_returns_company_return') then 'ok' else 'MISSING' end as redo_returns_unique_idx;

-- 7d2. QuickBooks Online integration (20260826070000_quickbooks_integration.sql)
select
  case when exists (select 1 from information_schema.tables where table_schema='public' and table_name='quickbooks_connections') then 'ok' else 'MISSING' end as quickbooks_connections,
  case when exists (select 1 from information_schema.tables where table_schema='public' and table_name='quickbooks_oauth_states') then 'ok' else 'MISSING' end as quickbooks_oauth_states,
  case when exists (select 1 from information_schema.tables where table_schema='public' and table_name='quickbooks_accounts') then 'ok' else 'MISSING' end as quickbooks_accounts,
  case when exists (select 1 from pg_indexes where schemaname='public' and tablename='quickbooks_connections' and indexname='uq_quickbooks_connections_company_realm') then 'ok' else 'MISSING' end as quickbooks_connections_unique_idx,
  case when exists (select 1 from information_schema.columns where table_schema='public' and table_name='accounting_coa_map' and column_name='qbo_account_id') then 'ok' else 'MISSING' end as coa_map_qbo_account_id,
  case when exists (select 1 from pg_policies where schemaname='public' and tablename='quickbooks_connections' and policyname='quickbooks_connections_admin_select') then 'ok' else 'MISSING' end as quickbooks_connections_admin_select,
  -- Credential-bearing table: a non-admin select policy here would expose live OAuth tokens.
  case when not exists (select 1 from pg_policies where schemaname='public' and tablename='quickbooks_connections' and policyname='quickbooks_connections_active_select') then 'ok' else 'OVERBROAD POLICY PRESENT' end as quickbooks_connections_no_broad_select;

-- 7d3. QuickBooks locations + location mapping (20260826090000_quickbooks_locations.sql)
select
  case when exists (select 1 from information_schema.tables where table_schema='public' and table_name='quickbooks_locations') then 'ok' else 'MISSING' end as quickbooks_locations,
  case when exists (select 1 from information_schema.tables where table_schema='public' and table_name='accounting_location_map') then 'ok' else 'MISSING' end as accounting_location_map,
  case when exists (select 1 from information_schema.columns where table_schema='public' and table_name='quickbooks_connections' and column_name='location_tracking_enabled') then 'ok' else 'MISSING' end as location_tracking_flag,
  case when exists (select 1 from pg_indexes where schemaname='public' and indexname='uq_accounting_location_map_company_tag') then 'ok' else 'MISSING' end as location_map_unique_idx;

-- 7d4. Per-location revenue/refund accounts (20260826110000_per_location_accounts.sql)
select
  case when exists (select 1 from information_schema.columns where table_schema='public' and table_name='accounting_location_map' and column_name='qbo_revenue_account_id') then 'ok' else 'MISSING' end as location_revenue_account,
  case when exists (select 1 from information_schema.columns where table_schema='public' and table_name='accounting_location_map' and column_name='qbo_refunds_account_id') then 'ok' else 'MISSING' end as location_refunds_account;

-- 7d5. QuickBooks reports + posting log (20260827210000_quickbooks_reports.sql)
select
  case when exists (select 1 from information_schema.tables where table_schema='public' and table_name='quickbooks_report_runs') then 'ok' else 'MISSING' end as quickbooks_report_runs,
  case when exists (select 1 from information_schema.tables where table_schema='public' and table_name='quickbooks_journal_postings') then 'ok' else 'MISSING' end as quickbooks_journal_postings,
  -- The database-level double-post guard. Without it a UI disable is the only thing stopping a duplicate period.
  case when exists (select 1 from pg_indexes where schemaname='public' and indexname='uq_quickbooks_postings_active_claim' and indexdef like 'CREATE UNIQUE INDEX%' and indexdef like '%unknown%' and indexdef like '%submitting%' and indexdef like '%posted%') then 'ok' else 'MISSING' end as posting_double_post_guard;

-- 7d6. Balance sheet schedules (20260827220000_schedule_items.sql)
select
  case when exists (select 1 from information_schema.tables where table_schema='public' and table_name='schedule_items') then 'ok' else 'MISSING' end as schedule_items,
  case when exists (select 1 from information_schema.tables where table_schema='public' and table_name='schedule_item_transactions') then 'ok' else 'MISSING' end as schedule_item_transactions,
  -- Stops one payment being stamped to two items, which would double-count the balance and break the tie-out.
  case when exists (select 1 from pg_indexes where schemaname='public' and indexname='uq_schedule_item_txn_once') then 'ok' else 'MISSING' end as one_stamp_per_txn,
  case when exists (select 1 from information_schema.views where table_schema='public' and table_name='schedule_item_amortization_v') then 'ok' else 'MISSING' end as amortization_view,
  case when exists (select 1 from information_schema.views where table_schema='public' and table_name='schedule_item_balances_v') then 'ok' else 'MISSING' end as balances_view,
  case when exists (select 1 from information_schema.tables where table_schema='public' and table_name='schedule_excluded_transactions') then 'ok' else 'MISSING' end as schedule_exclusions,
  case when exists (select 1 from information_schema.tables where table_schema='public' and table_name='schedule_item_files') then 'ok' else 'MISSING' end as schedule_item_files;

-- 7e. Redo return items + customer columns (20260812130000_redo_return_items.sql)
select
  case when exists (select 1 from information_schema.tables where table_schema='public' and table_name='redo_return_items') then 'ok' else 'MISSING' end as redo_return_items,
  case when exists (select 1 from information_schema.columns where table_schema='public' and table_name='redo_returns' and column_name='customer_email') then 'ok' else 'MISSING' end as redo_returns_customer_columns;

-- 7f. SILO chat readonly query RPC (20260813180000_silo_chat_readonly_query.sql)
select
  case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'chat_run_readonly_query') then 'ok' else 'MISSING' end as chat_run_readonly_query;

-- 7g. SILO chat taught-knowledge notes (20260813210000_silo_chat_notes.sql)
select
  case when exists (select 1 from information_schema.tables where table_schema='public' and table_name='silo_chat_notes') then 'ok' else 'MISSING' end as silo_chat_notes,
  case when exists (select 1 from information_schema.views where table_schema='public' and table_name='silo_chat_notes_v') then 'ok' else 'MISSING' end as silo_chat_notes_v,
  case when (select count(*) from pg_policies where schemaname='public' and tablename='silo_chat_notes') = 3 then 'ok' else 'MISSING' end as silo_chat_notes_policies;

-- 7h. SILO chat notes category, brand vs general (20260813220000_silo_chat_notes_category.sql)
select
  case when exists (select 1 from information_schema.columns where table_schema='public' and table_name='silo_chat_notes' and column_name='category') then 'ok' else 'MISSING' end as silo_chat_notes_category,
  case when exists (select 1 from information_schema.columns where table_schema='public' and table_name='silo_chat_notes_v' and column_name='category') then 'ok' else 'MISSING' end as silo_chat_notes_v_category;

-- 7i. SILO chat manager grants (20260813230000_silo_chat_managers.sql)
select
  case when exists (select 1 from information_schema.tables where table_schema='public' and table_name='silo_chat_managers') then 'ok' else 'MISSING' end as silo_chat_managers,
  case when exists (select 1 from information_schema.views where table_schema='public' and table_name='silo_chat_managers_v') then 'ok' else 'MISSING' end as silo_chat_managers_v,
  case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'can_manage_silo_notes') then 'ok' else 'MISSING' end as can_manage_silo_notes_fn,
  case when (select count(*) from pg_policies where schemaname='public' and tablename='silo_chat_managers') = 3 then 'ok' else 'MISSING' end as silo_chat_managers_policies;

-- 7j. Connection secrets locked to admin-tier reads (20260814000000_lock_connection_secrets_to_admin.sql)
select
  case when exists (select 1 from pg_policies where schemaname='public' and tablename='redo_connections' and policyname='redo_connections_admin_select') then 'ok' else 'MISSING' end as redo_connections_admin_select,
  case when exists (select 1 from pg_policies where schemaname='public' and tablename='ad_platform_connections' and policyname='ad_platform_connections_admin_select') then 'ok' else 'MISSING' end as ad_platform_connections_admin_select,
  case when not exists (select 1 from pg_policies where schemaname='public' and tablename='redo_connections' and policyname='redo_connections_active_select') then 'ok' else 'STALE POLICY STILL PRESENT' end as redo_connections_old_policy_gone,
  case when not exists (select 1 from pg_policies where schemaname='public' and tablename='ad_platform_connections' and policyname='ad_platform_connections_active_select') then 'ok' else 'STALE POLICY STILL PRESENT' end as ad_platform_connections_old_policy_gone;

-- 7c. Inventory MV company index (20260717190000)
select
  case when exists (select 1 from pg_indexes where schemaname='public' and tablename='inventory_on_hand_current_mv' and indexname='inventory_on_hand_current_mv_company_idx') then 'ok' else 'MISSING' end as inventory_mv_company_idx;

select
  col.column_name,
  case when col.column_name is not null then 'ok' else 'MISSING — run 20260623110000_shopify_connections_schema_align.sql' end as status
from (values
  ('last_test_status'),
  ('shop_name'),
  ('shop_currency'),
  ('access_token')
) as want(column_name)
left join information_schema.columns col
  on col.table_schema = 'public'
 and col.table_name = 'shopify_connections'
 and col.column_name = want.column_name;

select
  col.column_name,
  case when col.column_name is not null then 'ok' else 'MISSING — run 20260623120000_shopify_connections_scopes.sql' end as status
from (values
  ('scopes_granted'),
  ('scopes_missing'),
  ('scopes_checked_at')
) as want(column_name)
left join information_schema.columns col
  on col.table_schema = 'public'
 and col.table_name = 'shopify_connections'
 and col.column_name = want.column_name;

-- 8. Sales verification company scope (migration 20260624000000)
select
  want.policy_name,
  case when pol.policyname is not null then 'ok' else 'MISSING — run 20260624000000_sales_verification_company_scope.sql' end as status
from (values ('sales_by_day_active_select')) as want(policy_name)
left join pg_policies pol
  on pol.schemaname = 'public'
 and pol.tablename = 'sales_by_day'
 and pol.policyname = want.policy_name;

select
  case
    when exists (
      select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = 'refresh_sales_verification_store_comp_summary'
        and pg_get_functiondef(p.oid) ilike '%company_entity_id%'
    ) then 'ok'
    else 'MISSING — run 20260624000000_sales_verification_company_scope.sql'
  end as refresh_sales_verification_per_company;

select
  case
    when exists (
      select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = 'sales_verification_filtered_summary'
    ) then 'ok'
    else 'MISSING — run 20260624100000_sales_verification_filtered_summary.sql'
  end as sales_verification_filtered_summary_rpc;

select
  case
    when exists (
      select 1 from pg_views
      where schemaname = 'public' and viewname = 'sales_by_day_verification_v'
    ) then 'ok'
    else 'MISSING — run 20260629120000_shopify_sales_verification_dedupe.sql'
  end as sales_by_day_verification_view;

select
  case
    when exists (
      select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = 'purge_better_reports_overlap'
    ) then 'ok'
    else 'MISSING — run 20260629120000_shopify_sales_verification_dedupe.sql'
  end as purge_better_reports_overlap_rpc;

select
  case
    when exists (
      select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = 'refresh_sales_verification_store_comp_summary'
        and pg_get_functiondef(p.oid) ilike '%sales_by_day_verification_v%'
    ) then 'ok'
    else 'MISSING — run 20260629120000_shopify_sales_verification_dedupe.sql'
  end as refresh_sales_verification_deduped;

select
  case
    when exists (
      select 1 from pg_indexes
      where schemaname = 'public'
        and tablename = 'locations'
        and indexname = 'locations_company_location_code_key'
    ) then 'ok'
    else 'MISSING — run 20260630120000_locations_company_scoped_unique.sql'
  end as locations_company_scoped_unique;

select
  case
    when exists (
      select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = 'refresh_sales_verification_store_comp_summary'
        and pg_get_functiondef(p.oid) ilike '%America/Los_Angeles%'
    ) then 'ok'
    else 'MISSING — run 20260707030000_comp_summary_complete_day_anchor.sql'
  end as refresh_complete_day_anchor;

select
  case
    when exists (
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = 'product_samples'
        and column_name = 'tracker_id'
    ) then 'ok'
    else 'MISSING — run 20260708000000_product_samples_tracker_link.sql'
  end as product_samples_tracker_link;

select
  case
    when exists (
      select 1 from information_schema.tables
      where table_schema = 'public'
        and table_name = 'product_sample_tracker_links'
    ) then 'ok'
    else 'MISSING — run 20260812000000_product_sample_tracker_links.sql'
  end as product_sample_tracker_links;

select
  case
    when exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'launch_tasks'
        and column_name = 'launch_id' and is_nullable = 'YES'
    ) and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'launch_tasks'
        and column_name = 'is_private'
    ) then 'ok'
    else 'MISSING — run 20260708010000_tasks_evergreen_personal.sql'
  end as tasks_evergreen_personal;

select
  case
    when not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'launch_tasks'
        and policyname = 'launch_tasks_active_write' and cmd = 'ALL'
    ) and exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'launch_tasks'
        and policyname = 'launch_tasks_active_insert'
    ) then 'ok'
    else 'MISSING — run 20260721000000_fix_launch_tasks_private_select_leak.sql (private tasks leak to the whole company otherwise)'
  end as launch_tasks_private_select_leak_fix;

select
  case
    when exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'product_tags'
        and column_name = 'company_entity_id'
    ) and exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'product_tags'
        and policyname = 'product_tags_active_select'
    ) then 'ok'
    else 'MISSING — run 20260708020000_product_tags_company_scope.sql'
  end as product_tags_company_scope;

select
  case
    when exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'inventory_on_hand'
        and policyname = 'inventory_on_hand_active_write'
    ) and not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'inventory_on_hand'
        and policyname = 'inventory_on_hand_admin_all'
    ) then 'ok'
    else 'MISSING — run 20260708030000_inventory_on_hand_company_scope.sql'
  end as inventory_on_hand_company_scope;

select
  case
    when exists (
      select 1 from pg_attribute
      where attrelid = 'public.sales_monthly_product_type_rollup_mv'::regclass
        and attname = 'company_entity_id' and not attisdropped
    ) and not has_table_privilege('authenticated', 'public.sales_monthly_product_type_rollup_mv', 'SELECT')
    then 'ok'
    else 'MISSING — run 20260708040000 + 20260708060000'
  end as sales_rollup_mv_company_scope;

select
  case
    when exists (
      select 1 from pg_attribute
      where attrelid = 'public.sales_velocity_by_sku_location_mv'::regclass
        and attname = 'company_entity_id' and not attisdropped
    ) and not has_table_privilege('authenticated', 'public.sales_velocity_by_sku_location_mv', 'SELECT')
      and not has_table_privilege('authenticated', 'public.inventory_on_hand_current_mv', 'SELECT')
    then 'ok'
    else 'MISSING — run 20260708050000 + 20260708060000'
  end as sales_velocity_mv_company_scope;

select
  case
    when exists (
      select 1 from pg_attribute
      where attrelid = 'public.sales_velocity_by_sku_location_mv'::regclass
        and attname = 'product_name' and not attisdropped
    ) and exists (
      select 1 from pg_attribute
      where attrelid = 'public.inventory_workboard_v'::regclass
        and attname = 'product_title' and not attisdropped
    )
    then 'ok'
    else 'MISSING — run 20260821170000_sku_collision_velocity_fix.sql (product-name join key so two products sharing one SKU no longer blend sales/inventory)'
  end as sales_velocity_sku_collision_fix;

select
  case
    when exists (
      select 1 from pg_proc
      where pronamespace = 'public'::regnamespace and proname = 'product_search_rollup'
    ) and has_function_privilege('authenticated', 'public.product_search_rollup(date,date,text,text,boolean)', 'EXECUTE')
    then 'ok'
    else 'MISSING — run 20260821180000_product_search_rollup_rpc.sql (server-side rollup backing v2/bi-product-search.html)'
  end as product_search_rollup_rpc;

select
  case
    when exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'launch_task_templates'
        and policyname = 'launch_task_templates_active_select'
    ) and not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'launch_task_templates'
        and policyname = 'launch task templates read authenticated'
    ) then 'ok'
    else 'MISSING — run 20260709000000_launch_task_templates_company_scope.sql'
  end as launch_task_templates_company_scope;

select
  case
    when exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = 'shopify_payouts'
    ) and exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'shopify_payouts'
        and policyname = 'shopify_payouts_active_select'
    ) and exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = 'accounting_coa_map'
    ) and exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'accounting_sales_buckets'
    ) then 'ok'
    else 'MISSING — run 20260709010000_shopify_payouts_accounting.sql'
  end as shopify_payouts_accounting;

-- Action Items & Insights was retired 2026-09-01 (20260901030000) --
-- compute_silo_insights() and silo_insights_digest are gone on purpose. This
-- checks the RETIREMENT held, not that the feature exists: either object
-- reappearing means something (a bad merge, a stale branch re-applying old
-- migrations) resurrected a module that was deliberately removed.
select
  case
    when exists (select 1 from information_schema.tables
                  where table_schema = 'public' and table_name = 'silo_insights_digest')
      then 'UNEXPECTED — silo_insights_digest exists; Action Items was retired 2026-09-01, '
        || 'see 20260901030000_retire_silo_insights.sql'
    when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'compute_silo_insights')
      then 'UNEXPECTED — compute_silo_insights() exists; Action Items was retired 2026-09-01, '
        || 'see 20260901030000_retire_silo_insights.sql'
    else 'ok'
  end as silo_insights_retired;

select
  case
    when (select count(*) from information_schema.tables
          where table_schema = 'public'
            and table_name in ('employees','review_templates','review_template_questions','reviews',
                               'review_answers','review_private_notes','employee_goals','review_access_tokens')) = 8
      and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'is_exec_or_owner')
      and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'reviews_can_manage')
      and exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'employees'
                    and policyname = 'employees_active_select')
      and not exists (select 1 from pg_policies
                      where schemaname = 'public' and tablename = 'review_access_tokens')
    then 'ok'
    else 'MISSING — run 20260713200000_performance_reviews_phase1.sql'
  end as performance_reviews_phase1;

select
  case
    when exists (select 1 from pg_policies where schemaname = 'public'
                   and tablename = 'review_templates' and policyname = 'review_templates_employee_select')
     and exists (select 1 from pg_policies where schemaname = 'public'
                   and tablename = 'review_template_questions' and policyname = 'review_template_questions_employee_select')
    then 'ok'
    else 'MISSING — run 20260714170000_reviews_employee_template_read.sql'
  end as reviews_employee_template_read;

select
  case
    when exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'admin_update_profile'
          and pg_get_functiondef(p.oid) ilike '%entity_memberships%')
     and not exists (
        select 1 from public.profiles p
        where p.is_active
          and not exists (select 1 from public.entity_memberships em where em.user_id = p.id))
    then 'ok'
    else 'MISSING — run 20260714180000_admin_update_profile_entity_membership.sql'
  end as admin_update_profile_entity_membership;

select
  case
    when exists (
        select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'handle_new_user'
          and pg_get_functiondef(p.oid) ilike '%org_name%')
     and exists (
        select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'admin_list_profiles'
          and pg_get_functiondef(p.oid) ilike '%entity_memberships%')
     -- The GUARD, not the comment that used to sit above it: 20260804200000
     -- redefined admin_update_profile with the same guard and without the
     -- comment, and this check read MISSING for five weeks over a correct
     -- function (found by the first scheduled run, 2026-09-10).
     and exists (
        select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'admin_update_profile'
          and pg_get_functiondef(p.oid) ilike '%em.entity_id = public.active_company_id()%'
          and pg_get_functiondef(p.oid) ilike '%not authorized%')
    then 'ok'
    else 'MISSING — run 20260714190000_new_org_signup_flow.sql'
  end as new_org_signup_flow;

select
  case
    when exists (
        select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'org_invites' and c.relkind = 'r')
     and exists (
        select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'create_org_invite')
     and exists (
        select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'accept_org_invite')
     and not exists (
        -- deliberately RPC-only: no policies should exist on org_invites
        select 1 from pg_policies where schemaname = 'public' and tablename = 'org_invites')
    then 'ok'
    else 'MISSING — run 20260714200000_org_invites.sql'
  end as org_invites;

select
  case
    when exists (
        select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'active_membership_role')
     and exists (
        select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'is_admin'
          and pg_get_functiondef(p.oid) ilike '%entity_memberships%')
     and exists (
        select 1 from pg_policies
        where schemaname = 'public' and tablename = 'payment_requests'
          and policyname = 'payment_requests_internal_update'
          and qual ilike '%active_company_id%')
    then 'ok'
    else 'MISSING — run 20260714210000_per_company_roles.sql'
  end as per_company_roles;

select
  case
    when (select count(*) from pg_trigger
          where tgname in ('stamp_created_by','stamp_changed_by') and not tgisinternal) >= 24
    then 'ok'
    else 'MISSING — run 20260714220000_stamp_created_by.sql'
  end as stamp_created_by_triggers;

select
  case
    when exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = 'shopify_draft_orders'
    ) and exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'shopify_draft_orders'
        and policyname = 'shopify_draft_orders_active_select'
    ) and exists (
      select 1 from pg_constraint
      where conname = 'sync_jobs_job_type_check'
        and pg_get_constraintdef(oid) ilike '%draft_orders_sync%'
    ) then 'ok'
    else 'MISSING — run 20260723150000_shopify_draft_orders.sql'
  end as shopify_draft_orders;

-- 9. product_tracker <-> launch_product_readiness link (migration 20260723180000)
select
  col.column_name,
  case when col.column_name is not null then 'ok' else 'MISSING — run 20260723180000_link_launch_product_readiness_tracker.sql' end as status
from (values ('product_tracker_id')) as want(column_name)
left join information_schema.columns col
  on col.table_schema = 'public'
 and col.table_name = 'launch_product_readiness'
 and col.column_name = want.column_name;

-- 10. products_master attributes column (migration 20260723190000)
select
  col.column_name,
  case when col.column_name is not null then 'ok' else 'MISSING — run 20260723190000_products_master_legacy_tag_backfill.sql' end as status
from (values ('attributes')) as want(column_name)
left join information_schema.columns col
  on col.table_schema = 'public'
 and col.table_name = 'products_master'
 and col.column_name = want.column_name;

-- 11. product_tracker expected_units column (migration 20260723200000)
select
  col.column_name,
  case when col.column_name is not null then 'ok' else 'MISSING — run 20260723200000_product_tracker_expected_units.sql' end as status
from (values ('expected_units')) as want(column_name)
left join information_schema.columns col
  on col.table_schema = 'public'
 and col.table_name = 'product_tracker'
 and col.column_name = want.column_name;

-- 12. launch_product_readiness factory_id link (migration 20260723210000)
select
  col.column_name,
  case when col.column_name is not null then 'ok' else 'MISSING — run 20260723210000_launch_readiness_factory_link.sql' end as status
from (values ('factory_id')) as want(column_name)
left join information_schema.columns col
  on col.table_schema = 'public'
 and col.table_name = 'launch_product_readiness'
 and col.column_name = want.column_name;

-- 14. employee_managers multi-manager roster (migration 20260804010000)
select
  case
    when exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'employee_managers')
      and exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'employee_managers'
                    and policyname = 'employee_managers_active_select')
    then 'ok'
    else 'MISSING — run 20260804010000_employee_managers_multi_manager.sql'
  end as employee_managers_multi_manager,
  -- Every employee should have at least one manager link (0 is fine on a fresh install).
  (select count(*) from public.employees e
    where not exists (select 1 from public.employee_managers em where em.employee_id = e.id)) as employees_missing_a_manager_link;

-- 13. Quick counts (0 is fine on a fresh install)
select
  (select count(*) from public.factories)            as factories,
  (select count(*) from public.po_headers)           as po_headers,
  (select count(*) from public.po_costing)           as po_costing,
  (select count(*) from public.profiles)             as profiles,
  (select count(*) from public.launch_calendar)      as launches,
  (select count(*) from public.shopify_connections)  as shopify_connections;

-- 15. ar_sync_status_v must run as its owner (security_invoker = false) or the
--     AR sync freshness banner (wholesale page + Backend Hub ops panel) silently
--     returns zero rows for every real user — job_sync_state is deny-all RLS
--     for everyone except a bypassrls role (migration 20260805030000).
select
  case
    when not exists (select 1 from pg_class where relname = 'ar_sync_status_v' and relnamespace = 'public'::regnamespace)
      then 'MISSING — ar_sync_status_v view not found'
    when exists (
      select 1 from pg_class
      where relname = 'ar_sync_status_v' and relnamespace = 'public'::regnamespace
        and 'security_invoker=true' = any(reloptions)
    ) then 'MISSING — run 20260805030000_ar_sync_status_v_restore_definer_read.sql'
    else 'ok'
  end as ar_sync_status_v_definer_read;

-- 16. default_page bootstrap (migration 20260805040000) — 0 is fine once
--     everyone has picked their own; this is just visibility, not a hard gate.
select count(*) as profiles_with_no_default_page
from public.profiles where default_page is null;

-- 17. Profile avatars (migration 20260805050000)
select
  case
    when not exists (select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='avatar_url')
      then 'MISSING — profiles.avatar_url column'
    when not exists (select 1 from storage.buckets where id='avatars' and public=true)
      then 'MISSING — avatars storage bucket'
    when (select count(*) from pg_policies where schemaname='storage' and tablename='objects' and policyname like 'avatars_%') < 4
      then 'MISSING — avatars storage policies'
    when not exists (select 1 from information_schema.columns where table_schema='public' and table_name='payment_requests_v' and column_name='assigned_to_avatar_url')
      then 'MISSING — payment_requests_v.assigned_to_avatar_url'
    else 'ok'
  end as profile_avatars;

-- 18. mail_items_v avatars (migration 20260805060000)
select
  case
    when not exists (select 1 from information_schema.columns where table_schema='public' and table_name='mail_items_v' and column_name='assigned_to_avatar_url')
      then 'MISSING — mail_items_v.assigned_to_avatar_url'
    when not exists (select 1 from pg_class where relname = 'mail_items_v' and 'security_invoker=true' = any(reloptions))
      then 'MISSING — mail_items_v security_invoker'
    else 'ok'
  end as mail_items_v_avatars;

-- 19. sales_comp_as_of RPC (migration 20260805070000)
select
  case
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='sales_comp_as_of')
      then 'MISSING — run 20260805070000_sales_comp_as_of_rpc.sql'
    else 'ok'
  end as sales_comp_as_of_rpc;

-- 20. TikTok Live schedule (migration 20260807120000)
select
  case
    when to_regclass('public.live_sessions') is null
      then 'MISSING — run 20260807120000_tiktok_live_schedule.sql'
    when not exists (select 1 from pg_indexes where schemaname='public' and indexname='live_sessions_company_slot_key')
      then 'MISSING — live_sessions_company_slot_key unique index'
    when not exists (select 1 from pg_class where relname='live_sessions_v' and 'security_invoker=true' = any(reloptions))
      then 'MISSING — live_sessions_v security_invoker'
    when (select count(*) from pg_policies where schemaname='public' and tablename='live_sessions') < 4
      then 'MISSING — live_sessions RLS policies'
    when not exists (select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relname='live_sessions' and t.tgname='stamp_created_by')
      then 'MISSING — live_sessions stamp_created_by trigger'
    else 'ok'
  end as tiktok_live_schedule;

-- 21. Live schedule payroll payout (migration 20260807150000)
select
  case
    when not exists (select 1 from information_schema.columns where table_schema='public' and table_name='live_sessions' and column_name='payout_total')
      then 'MISSING — run 20260807150000_live_schedule_payroll_payout.sql'
    when not exists (select 1 from information_schema.columns where table_schema='public' and table_name='live_sessions_v' and column_name='payout_total')
      then 'MISSING — live_sessions_v not recreated with payout columns'
    when not exists (select 1 from pg_constraint where conname='payment_requests_request_type_check'
                     and pg_get_constraintdef(oid) like '%payroll_payment%')
      then 'MISSING — payroll_payment not in payment_requests_request_type_check'
    else 'ok'
  end as live_schedule_payroll_payout;

-- 22. Organization calendar (migration 20260810120000)
select
  case
    when to_regclass('public.calendar_events') is null
      then 'MISSING — run 20260810120000_org_calendar.sql'
    when (select count(*) from pg_policies where schemaname='public' and tablename='calendar_events') < 4
      then 'MISSING — calendar_events RLS policies'
    when not exists (select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relname='calendar_events' and t.tgname='stamp_created_by')
      then 'MISSING — calendar_events stamp_created_by trigger'
    when not exists (select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relname='calendar_events' and t.tgname='stamp_company_entity_id')
      then 'MISSING — calendar_events stamp_company_entity_id trigger'
    when to_regclass('public.calendar_events_v') is null
      then 'MISSING — calendar_events_v view'
    when not exists (select 1 from pg_class where relname='calendar_events_v' and 'security_invoker=true' = any(reloptions))
      then 'MISSING — calendar_events_v security_invoker'
    when not exists (select 1 from pg_indexes where schemaname='public' and indexname='calendar_events_company_start_idx')
      then 'MISSING — calendar_events_company_start_idx'
    when not exists (select 1 from pg_indexes where schemaname='public' and indexname='payment_requests_company_due_idx')
      then 'MISSING — org-calendar source date indexes'
    else 'ok'
  end as org_calendar;

-- 22. Launch release brief — approved copy / creatives (migration 20260817180000)
select
  case
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='launch_calendar'
                       and column_name='approved_copy')
      then 'MISSING — run 20260817180000_launch_calendar_approved_copy_creatives.sql'
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='launch_calendar'
                       and column_name='approved_creatives')
      then 'MISSING — launch_calendar.approved_creatives'
    else 'ok'
  end as launch_approved_copy_creatives;

-- 23. Sample notifications (migration 20260817190000)
select
  case
    when not exists (select 1 from pg_proc where proname = 'notify_sample_events')
      then 'MISSING — run 20260817190000_sample_notifications.sql'
    when not exists (select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid
                     where c.relname='product_samples' and t.tgname='trg_sample_notify')
      then 'MISSING — trg_sample_notify trigger'
    else 'ok'
  end as sample_notifications;

-- 24. Product samples request_source (migration 20260817200000)
select
  case
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='product_samples'
                       and column_name='request_source')
      then 'MISSING — run 20260817200000_product_samples_request_source.sql'
    else 'ok'
  end as product_samples_request_source;

-- 25. Shopify order-level analytics (migration 20260817210000)
select
  case
    when not exists (select 1 from information_schema.tables
                     where table_schema='public' and table_name='shopify_orders')
      then 'MISSING — run 20260817210000_shopify_order_level_analytics.sql'
    when not exists (select 1 from information_schema.tables
                     where table_schema='public' and table_name='shopify_order_lines')
      then 'MISSING — shopify_order_lines'
    when not exists (select 1 from information_schema.tables
                     where table_schema='public' and table_name='shopify_channel_map')
      then 'MISSING — shopify_channel_map'
    when not exists (select 1 from pg_policies
                     where schemaname='public' and tablename='shopify_orders'
                       and policyname='shopify_orders_active_select')
      then 'MISSING — shopify_orders RLS policy'
    when not exists (select 1 from information_schema.views
                     where table_schema='public' and table_name='shopify_orders_v')
      then 'MISSING — shopify_orders_v view'
    else 'ok'
  end as shopify_order_level_analytics;

-- 26. Ask SILO saved reports (migration 20260818050000)
select
  case
    when not exists (select 1 from information_schema.tables
                     where table_schema='public' and table_name='silo_chat_saved_reports')
      then 'MISSING — run 20260818050000_silo_chat_saved_reports.sql'
    when not exists (select 1 from pg_policies
                     where schemaname='public' and tablename='silo_chat_saved_reports'
                       and policyname='silo_chat_saved_reports_select')
      then 'MISSING — silo_chat_saved_reports RLS policies'
    when not exists (select 1 from information_schema.views
                     where table_schema='public' and table_name='silo_chat_saved_reports_v')
      then 'MISSING — silo_chat_saved_reports_v view'
    else 'ok'
  end as silo_chat_saved_reports;

-- 27. Orders backfill job type (migration 20260818060000)
select
  case
    when not exists (select 1 from pg_constraint
                     where conname = 'sync_jobs_job_type_check'
                       and pg_get_constraintdef(oid) ilike '%orders_backfill%')
      then 'MISSING — run 20260818060000_orders_backfill_job_type.sql'
    else 'ok'
  end as orders_backfill_job_type;

-- 28. Product samples assignee + notifications (migration 20260818130000)
select
  case
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='product_samples'
                       and column_name='assigned_to')
      then 'MISSING — run 20260818130000_product_samples_assignee_notifications.sql'
    when not exists (select 1 from information_schema.views
                     where table_schema='public' and table_name='product_samples_v')
      then 'MISSING — product_samples_v view'
    -- Since 20260910160000 the trigger is deliberately the cut-down version
    -- production runs (SAMPLE_REQUESTED / SAMPLE_RECEIVED on insert, and
    -- SAMPLE_SIZE_REQUEST for catalog photo pulls only). SAMPLE_ASSIGNED and
    -- SAMPLE_WAREHOUSE_READY are deferred to the Slack rebuild. This asserts
    -- the recorded shape, not the wider one 20260818130000 wrote.
    when not exists (
      select 1 from pg_proc p join pg_language l on l.oid = p.prolang
      where p.proname = 'notify_sample_events' and l.lanname = 'plpgsql'
        and pg_get_functiondef(p.oid) ilike '%SAMPLE_SIZE_REQUEST%'
        and pg_get_functiondef(p.oid) ilike '%new.request_source = ''catalog_photo_request''%'
    )
      then 'MISSING — notify_sample_events() is not the recorded production shape; run 20260910160000_notify_sample_events_as_deployed.sql'
    else 'ok'
  end as product_samples_assignee_notifications;

-- 29. Sample notification log (migration 20260818150000)
select
  case
    when not exists (select 1 from information_schema.tables
                     where table_schema='public' and table_name='sample_notification_log')
      then 'MISSING — run 20260818150000_sample_notification_log.sql'
    when not exists (select 1 from information_schema.views
                     where table_schema='public' and table_name='sample_notification_log_v')
      then 'MISSING — sample_notification_log_v view'
    when not exists (select 1 from pg_policies
                     where schemaname='public' and tablename='sample_notification_log'
                       and policyname='sample_notification_log_active_select')
      then 'MISSING — sample_notification_log RLS select policy'
    else 'ok'
  end as sample_notification_log;

-- 30. Sample requested vs received on insert (migration 20260818170000)
select
  case
    when not exists (
      select 1 from pg_proc p join pg_language l on l.oid = p.prolang
      where p.proname = 'notify_sample_events' and l.lanname = 'plpgsql'
        and pg_get_functiondef(p.oid) ilike '%case when coalesce(new.sample_status%'
    )
      then 'MISSING — run 20260818170000_sample_requested_vs_received_on_insert.sql'
    else 'ok'
  end as sample_requested_vs_received_on_insert;

-- 31. Sample insert no double-fire (migration 20260818180000)
select
  case
    when not exists (
      select 1 from pg_proc p join pg_language l on l.oid = p.prolang
      where p.proname = 'notify_sample_events' and l.lanname = 'plpgsql'
        and pg_get_functiondef(p.oid) ilike '%and (new.size_requests is null or btrim(new.size_requests) = '''')%'
    )
      then 'MISSING — run 20260818180000_sample_insert_no_double_fire.sql'
    else 'ok'
  end as sample_insert_no_double_fire;

-- 32. PPS / Full Run received split (migration 20260818190000)
select
  case
    when not exists (
      select 1 from pg_proc p join pg_language l on l.oid = p.prolang
      where p.proname = 'notify_sample_events' and l.lanname = 'plpgsql'
        and pg_get_functiondef(p.oid) ilike '%pps_received%'
        and pg_get_functiondef(p.oid) ilike '%full_run_received%'
    )
      then 'MISSING — run 20260818190000_sample_pps_full_run_received.sql'
    else 'ok'
  end as sample_pps_full_run_received;

-- 33. Sample received transition within family (migration 20260818200000)
-- Superseded by 20260910160000: production never ran the received-on-UPDATE
-- path and the decision is to leave it to the Slack rebuild. The check now
-- guards the opposite drift -- someone re-applying the 20260818 version by
-- hand and reintroducing a notification path nobody decided on.
select
  case
    when exists (
      select 1 from pg_proc p join pg_language l on l.oid = p.prolang
      where p.proname = 'notify_sample_events' and l.lanname = 'plpgsql'
        and pg_get_functiondef(p.oid) ilike '%SAMPLE_WAREHOUSE_READY%'
    )
      then 'UNEXPECTED — notify_sample_events() fires SAMPLE_WAREHOUSE_READY/ASSIGNED again; that is the Slack rebuild''s decision, see 20260910160000'
    else 'ok'
  end as sample_received_transition_within_family;

-- 34. Incoming shipment tracking for PO Report (migration 20260818210000)
select
  case
    when not exists (select 1 from information_schema.tables
                     where table_schema='public' and table_name='incoming_shipments')
      then 'MISSING — run 20260818210000_incoming_shipment_lines.sql'
    when not exists (select 1 from information_schema.tables
                     where table_schema='public' and table_name='incoming_shipment_lines')
      then 'MISSING — incoming_shipment_lines table'
    when not exists (select 1 from information_schema.views
                     where table_schema='public' and table_name='v_po_shipment_lines')
      then 'MISSING — v_po_shipment_lines view'
    when not exists (select 1 from pg_policies
                     where schemaname='public' and tablename='incoming_shipments'
                       and policyname='incoming_shipments_active_insert')
      then 'MISSING — incoming_shipments write RLS not widened to any active company member'
    when not exists (select 1 from pg_policies
                     where schemaname='public' and tablename='incoming_shipment_lines'
                       and policyname='incoming_shipment_lines_active_insert')
      then 'MISSING — incoming_shipment_lines RLS'
    else 'ok'
  end as incoming_shipment_tracking;

-- 35. factories.country (migration 20260818220000) — powers the PO Report shipment map
select
  case
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='factories' and column_name='country')
      then 'MISSING — run 20260818220000_factories_country.sql'
    else 'ok'
  end as factories_country;

-- Trigram search indexes (migration 20260820130000) — Ask SILO / BI Product Search ILIKE speed
select
  case
    when not exists (select 1 from pg_extension where extname = 'pg_trgm')
      then 'MISSING — run 20260820130000_sales_by_day_trgm_search_indexes.sql (pg_trgm not installed)'
    when not exists (select 1 from pg_indexes where schemaname='public' and tablename='sales_by_day'
                       and indexname='sales_by_day_product_name_trgm_idx')
      then 'MISSING — sales_by_day_product_name_trgm_idx'
    when not exists (select 1 from pg_indexes where schemaname='public' and tablename='sales_by_day'
                       and indexname='sales_by_day_sku_trgm_idx')
      then 'MISSING — sales_by_day_sku_trgm_idx'
    else 'ok'
  end as sales_by_day_trgm_search_indexes;

-- Trigram search indexes on inventory (migration 20260820140000)
select
  case
    when not exists (select 1 from pg_indexes where schemaname='public' and tablename='inventory_on_hand'
                       and indexname='inventory_on_hand_product_title_trgm_idx')
      then 'MISSING — run 20260820140000_inventory_on_hand_trgm_search_indexes.sql'
    when not exists (select 1 from pg_indexes where schemaname='public' and tablename='inventory_on_hand'
                       and indexname='inventory_on_hand_variant_sku_trgm_idx')
      then 'MISSING — inventory_on_hand_variant_sku_trgm_idx'
    else 'ok'
  end as inventory_on_hand_trgm_search_indexes;

-- Saved reports visibility (migration 20260821090000) — My reports vs Company reports
select
  case
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='silo_chat_saved_reports'
                       and column_name='visibility')
      then 'MISSING — run 20260821090000_silo_chat_saved_reports_visibility.sql'
    when not exists (select 1 from pg_policies
                     where schemaname='public' and tablename='silo_chat_saved_reports'
                       and policyname='silo_chat_saved_reports_select'
                       and qual like '%visibility%')
      then 'MISSING — saved-reports select policy not visibility-aware'
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='silo_chat_saved_reports_v'
                       and column_name='visibility')
      then 'MISSING — silo_chat_saved_reports_v lacks visibility column'
    else 'ok'
  end as silo_chat_saved_reports_visibility;

-- Product Concepts (migration 20260821110000) — Ask SILO's product-generation
-- branch, still gated to PRODUCT_CONCEPT_TESTERS in the silo-chat edge
-- function while it's tested.
select
  case
    when not exists (select 1 from information_schema.tables
                     where table_schema='public' and table_name='product_concepts')
      then 'MISSING — run 20260821110000_product_concepts.sql'
    when not exists (select 1 from pg_policies
                     where schemaname='public' and tablename='product_concepts'
                       and policyname='product_concepts_select')
      then 'MISSING — product_concepts RLS policies'
    when not exists (select 1 from information_schema.views
                     where table_schema='public' and table_name='product_concepts_v')
      then 'MISSING — product_concepts_v view'
    else 'ok'
  end as product_concepts;

-- Product Concepts reference images (migration 20260821130000) — reference/
-- inspiration image upload, still gated to PRODUCT_CONCEPT_TESTERS.
select
  case
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='product_concepts'
                       and column_name='reference_image_urls')
      then 'MISSING — run 20260821130000_product_concept_images.sql'
    when not exists (select 1 from storage.buckets where id='product-concept-images')
      then 'MISSING — product-concept-images storage bucket'
    when not exists (select 1 from pg_policies
                     where schemaname='storage' and tablename='objects'
                       and policyname='product_concept_images_public_read')
      then 'MISSING — product-concept-images storage policies'
    else 'ok'
  end as product_concept_images;

-- Product Concepts PO link (migration 20260821140000) — prep column so an
-- approved concept can be connected to the PO it becomes.
select
  case
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='product_concepts'
                       and column_name='resulting_po_header_id')
      then 'MISSING — run 20260821140000_product_concept_po_link.sql'
    else 'ok'
  end as product_concept_po_link;

-- Product Concepts full launch-plan fields (migration 20260821160000) —
-- size breakdown, channel split, launch time, marketing spend, weekly
-- revenue projection, email/SMS plan, marketing copy.
select
  case
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='product_concepts'
                       and column_name='suggested_marketing_copy')
      then 'MISSING — run 20260821160000_product_concept_launch_plan_fields.sql'
    else 'ok'
  end as product_concept_launch_plan_fields;

-- Product Concepts collections (migration 20260821170000) — parent/child
-- grouping for multi-product releases sharing one strategic brief.
select
  case
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='product_concepts'
                       and column_name='parent_concept_id')
      then 'MISSING — run 20260821170000_product_concept_collections.sql'
    else 'ok'
  end as product_concept_collections;

-- Product Concepts structured workflow (migration 20260825120000) —
-- structured brief columns, per-field evidence classification, and the
-- immutable revision-history table + its write trigger.
select
  case
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='product_concepts'
                       and column_name='field_evidence')
      then 'MISSING — run 20260825120000_product_concept_structured_workflow.sql'
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='product_concepts'
                       and column_name='current_revision_number')
      then 'MISSING — product_concepts.current_revision_number'
    when not exists (select 1 from information_schema.tables
                     where table_schema='public' and table_name='product_concept_revisions')
      then 'MISSING — product_concept_revisions table'
    when not exists (select 1 from pg_policies
                     where schemaname='public' and tablename='product_concept_revisions'
                       and policyname='product_concept_revisions_select')
      then 'MISSING — product_concept_revisions RLS policy'
    -- History must stay immutable: a client-writable policy here would
    -- silently defeat the "preserve prior concept work" guarantee.
    when exists (select 1 from pg_policies
                 where schemaname='public' and tablename='product_concept_revisions'
                   and cmd in ('INSERT','UPDATE','DELETE'))
      then 'UNEXPECTED — product_concept_revisions must have no client write policies'
    when not exists (select 1 from pg_trigger
                     where tgrelid='public.product_concepts'::regclass
                       and tgname='trg_product_concept_revision')
      then 'MISSING — trg_product_concept_revision trigger'
    when not exists (select 1 from information_schema.views
                     where table_schema='public' and table_name='product_concept_revisions_v')
      then 'MISSING — product_concept_revisions_v view'
    else 'ok'
  end as product_concept_structured_workflow;

-- Product Concepts phase (migration 20260825140000) — completeness axis
-- ('core_draft' | 'full_brief'), orthogonal to the status approval axis.
select
  case
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='product_concepts'
                       and column_name='phase')
      then 'MISSING — run 20260825140000_product_concept_phase.sql'
    when not exists (select 1 from pg_constraint
                     where conrelid='public.product_concepts'::regclass
                       and conname='product_concepts_phase_check')
      then 'MISSING — product_concepts_phase_check constraint'
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='product_concepts_v'
                       and column_name='phase')
      then 'MISSING — phase not exposed on product_concepts_v'
    -- The backfill suspends the revision trigger; a migration that left it
    -- disabled would silently stop recording concept history from then on.
    when not exists (select 1 from pg_trigger
                     where tgrelid='public.product_concepts'::regclass
                       and tgname='trg_product_concept_revision'
                       and tgenabled = 'O')
      then 'BROKEN — trg_product_concept_revision is disabled; concept history is not being recorded'
    else 'ok'
  end as product_concept_phase;

-- Ask SILO schema catalog + health view (migration 20260821210000)
select
  case
    when not exists (select 1 from information_schema.tables
                     where table_schema='public' and table_name='silo_chat_schema_catalog')
      then 'MISSING — run 20260821210000_silo_chat_schema_catalog.sql'
    when (select count(*) from public.silo_chat_schema_catalog) = 0
      then 'MISSING — catalog empty: select refresh_chat_schema_catalog()'
    when (select jsonb_array_length(columns) from public.silo_chat_schema_catalog where relname='sales_by_day')
         is distinct from (select count(*)::int from information_schema.columns
                           where table_schema='public' and table_name='sales_by_day')
      then 'STALE — schema changed since last refresh: select refresh_chat_schema_catalog()'
    when not exists (select 1 from information_schema.views
                     where table_schema='public' and table_name='silo_chat_health_v')
      then 'MISSING — silo_chat_health_v'
    else 'ok'
  end as silo_chat_schema_catalog;

-- Trigram search indexes on shopify_order_lines (migration 20260822010000)
select
  case
    when not exists (select 1 from pg_indexes where schemaname='public' and tablename='shopify_order_lines'
                       and indexname='shopify_order_lines_title_trgm_idx')
      then 'MISSING — run 20260822010000_shopify_order_lines_trgm_indexes.sql'
    when not exists (select 1 from pg_indexes where schemaname='public' and tablename='shopify_order_lines'
                       and indexname='shopify_order_lines_sku_trgm_idx')
      then 'MISSING — shopify_order_lines_sku_trgm_idx'
    else 'ok'
  end as shopify_order_lines_trgm_search_indexes;

-- Compensation Adjustment Requests (migration 20260824000000) — Team module
-- phase 2: raise/bonus/promotion/equity requests routed to finance.
select
  case
    when not exists (select 1 from information_schema.tables
                     where table_schema='public' and table_name='comp_adjustment_requests')
      then 'MISSING — run 20260824000000_comp_adjustment_requests.sql'
    when not exists (select 1 from information_schema.tables
                     where table_schema='public' and table_name='comp_adjustment_request_activity')
      then 'MISSING — comp_adjustment_request_activity'
    when not exists (select 1 from information_schema.views
                     where table_schema='public' and table_name='comp_adjustment_requests_v')
      then 'MISSING — comp_adjustment_requests_v'
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname='public' and p.proname='current_user_can_manage_comp_requests')
      then 'MISSING — current_user_can_manage_comp_requests()'
    else 'ok'
  end as comp_adjustment_requests;

-- Launch actuals (migration 20260826010000) — the measurement hop of
-- concept -> PO -> launch -> actuals. Also asserts the PO-side links from
-- 20260825210000, since launch_actuals_v resolves SKUs exclusively through
-- linked_po_id -> po_lines and is meaningless without them.
select
  case
    when not exists (select 1 from information_schema.views
                     where table_schema='public' and table_name='launch_actuals_v')
      then 'MISSING — run 20260826010000_launch_actuals.sql'
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='launch_actuals_v'
                       and column_name='sku_source')
      then 'MISSING — sku_source not exposed on launch_actuals_v'
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='launch_actuals_v'
                       and column_name='window_90d_complete')
      then 'MISSING — window completeness flags not exposed on launch_actuals_v'
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='launch_calendar'
                       and column_name='launch_end_date')
      then 'MISSING — run 20260826020000_launch_period.sql'
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='launch_actuals_v'
                       and column_name='units_in_period')
      then 'MISSING — period measurement not exposed on launch_actuals_v'
    when not exists (select 1 from information_schema.tables
                     where table_schema='public' and table_name='po_concept_links')
      then 'MISSING — run 20260825210000_concept_to_po_links.sql'
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='launch_calendar'
                       and column_name='source_concept_id')
      then 'MISSING — launch_calendar.source_concept_id'
    else 'ok'
  end as launch_actuals;

-- Strategy notes + unit demand coverage (20260826040000 / 20260826050000).
-- Strategy notes are how a stated human bet overrides a history-only
-- recommendation; demand coverage is the unit-based planning context.
select
  case
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='silo_chat_notes'
                       and column_name='effective_until')
      then 'MISSING — run 20260826040000_silo_chat_strategy_notes.sql'
    when not exists (select 1 from pg_constraint
                     where conrelid='public.silo_chat_notes'::regclass
                       and pg_get_constraintdef(oid) like '%strategy%')
      then 'MISSING — strategy category not allowed by silo_chat_notes check constraint'
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='silo_chat_notes_v'
                       and column_name='is_expired')
      then 'MISSING — is_expired not exposed on silo_chat_notes_v'
    when not exists (select 1 from information_schema.views
                     where table_schema='public' and table_name='demand_coverage_by_type_v')
      then 'MISSING — run 20260826050000_demand_coverage.sql'
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='demand_coverage_by_type_v'
                       and column_name='has_sales_history')
      then 'MISSING — has_sales_history not exposed (unproven vs zero demand)'
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='demand_coverage_by_type_v'
                       and column_name='momentum_pct')
      then 'MISSING — momentum_pct not exposed (the growth half of the signal)'
    else 'ok'
  end as strategy_notes_and_demand_coverage;

-- ── Marketing Explorer views (20260826060000) ─────────────────────────
-- The defined measure layer behind /v2/marketing-explorer.html. Ratio
-- metrics are computed from summed components inside these views, so a
-- caller that re-derives them from day rows gets the same answer.
select
  case
    when not exists (select 1 from information_schema.views
                     where table_schema='public' and table_name='marketing_facts_daily_v')
      then 'MISSING — run 20260826060000_marketing_explorer_views.sql'
    when not exists (select 1 from information_schema.views
                     where table_schema='public' and table_name='marketing_campaign_summary_v')
      then 'MISSING — marketing_campaign_summary_v not created'
    when not exists (select 1 from information_schema.views
                     where table_schema='public' and table_name='marketing_daily_totals_v')
      then 'MISSING — marketing_daily_totals_v not created'
    when not exists (select 1 from information_schema.views
                     where table_schema='public' and table_name='meta_ad_performance_v')
      then 'MISSING — meta_ad_performance_v not created'
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='marketing_campaign_summary_v'
                       and column_name='looks_upper_funnel')
      then 'MISSING — looks_upper_funnel not exposed (awareness campaigns would skew portfolio ROAS)'
    when exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
                 where n.nspname='public'
                   and c.relname in ('marketing_facts_daily_v','marketing_campaign_summary_v',
                                     'marketing_daily_totals_v','meta_ad_performance_v')
                   and c.relkind='v'
                   and coalesce((c.reloptions::text like '%security_invoker=true%'), false) is false)
      then 'MISSING — a marketing explorer view is not security_invoker (RLS would not propagate)'
    else 'ok'
  end as marketing_explorer_views;

-- ── Launch measurability (20260826070000) ─────────────────────────────
select
  case
    when not exists (select 1 from information_schema.views
                     where table_schema='public' and table_name='launch_measurability_v')
      then 'MISSING — run 20260826070000_launch_measurability.sql'
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='launch_measurability_v'
                       and column_name='overlapping_launches')
      then 'MISSING — overlapping_launches not exposed (period estimates would look valid when they are not)'
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='launch_measurability_v'
                       and column_name='measurability')
      then 'MISSING — measurability not exposed'
    when not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
                     where n.nspname='public' and c.relname='launch_measurability_v'
                       and c.reloptions::text like '%security_invoker=true%')
      then 'MISSING — launch_measurability_v is not security_invoker'
    else 'ok'
  end as launch_measurability;

-- ── Launch product actuals (20260826080000) ───────────────────────────
select
  case
    when not exists (select 1 from information_schema.views
                     where table_schema='public' and table_name='launch_product_actuals_v')
      then 'MISSING — run 20260826080000_launch_product_actuals.sql'
    when not exists (select 1 from information_schema.views
                     where table_schema='public' and table_name='launch_product_sales_v')
      then 'MISSING — launch_product_sales_v not created'
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='launch_product_actuals_v'
                       and column_name='resolution_note')
      then 'MISSING — resolution_note not exposed (unmeasured launches would read as weak ones)'
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='launch_measurability_v'
                       and column_name='products_resolved')
      then 'MISSING — launch_measurability_v not updated for product-based measurement'
    else 'ok'
  end as launch_product_actuals;

-- ── Ask SILO query timeout (20260826090000) ───────────────────────────
-- Phase-2 concept grounding was being recorded as "unknown" because these
-- queries could not finish inside 10s. If this reverts, briefs go sparse
-- again and the cause is invisible unless you read the unknowns array.
select
  case
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='chat_run_readonly_query')
      then 'MISSING — chat_run_readonly_query does not exist'
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='chat_run_readonly_query'
                       and pg_get_functiondef(p.oid) like '%30s%')
      then 'MISSING — run 20260826100000_chat_query_timeout_30s.sql (still on the old 10s budget)'
    when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                 where n.nspname='public' and p.proname='chat_run_readonly_query'
                   and p.prosecdef)
      then 'MISSING — chat_run_readonly_query became SECURITY DEFINER; it must stay INVOKER so RLS scopes every read'
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='chat_run_readonly_query'
                       and pg_get_functiondef(p.oid) like '%limit 1000%')
      then 'MISSING — run 20260904320000_readonly_query_pagination.sql (still on the old 500-row cap, or the cap was dropped)'
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='chat_run_readonly_query'
                       and p.pronargs = 2)
      then 'MISSING — chat_run_readonly_query(text) has not been replaced by the (text, p_offset) pagination overload'
    -- Caught live 2026-09-04 applying 20260904320000: every migration since
    -- 20260825030904 that recreated this function via drop+create revoked
    -- EXECUTE only from `public`, never from `anon` by name -- and Supabase's
    -- default privileges on the public schema grant EXECUTE to anon on every
    -- newly created function, so each drop+create silently reopened a hole
    -- the original migration (20260813171926) had explicitly closed
    -- (`revoke ... from public, anon`). This function runs arbitrary
    -- read-only SQL as SECURITY INVOKER; it must never depend on RLS alone
    -- to keep an unauthenticated caller out.
    when exists (select 1 from information_schema.routine_privileges
                 where routine_schema='public' and routine_name='chat_run_readonly_query'
                   and grantee='anon')
      then 'MISSING — anon can EXECUTE chat_run_readonly_query. Run: revoke all on function public.chat_run_readonly_query(text, integer) from public, anon;'
    else 'ok'
  end as chat_query_timeout;

-- ── Ask SILO read-only boundary (20260916120000) ──────────────────────
-- The SELECT/WITH check is a check on the SHAPE of the statement text, and a
-- SELECT is not a read: `select public.set_active_company(...)` is a single
-- semicolon-free SELECT that UPDATEs the column every RLS policy in SILO
-- reads. transaction_read_only=on is what makes the refusal the EXECUTOR's,
-- so it holds however the write is reached. If this reverts, nothing errors
-- and nothing looks different -- which is why it is checked here.
select
  case
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='chat_run_readonly_query')
      then 'MISSING — chat_run_readonly_query does not exist'
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='chat_run_readonly_query'
                       and lower(pg_get_functiondef(p.oid)) like '%set transaction read only%')
      then 'CRITICAL — chat_run_readonly_query does not enter a read-only transaction; a SELECT calling a volatile function can still write. Run 20260916120000_chat_readonly_query_read_only_txn.sql'
    -- STABLE looks like the safer declaration and is not one: SPI's
    -- non-volatile guard is per function, so a nested VOLATILE function still
    -- writes, and a non-volatile function cannot set the statement timeout at
    -- all. Measured, not assumed -- see the database test.
    when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                 where n.nspname='public' and p.proname='chat_run_readonly_query'
                   and p.provolatile <> 'v')
      then 'CRITICAL — chat_run_readonly_query is no longer VOLATILE; it cannot set its own statement timeout, and non-volatility does not stop a nested volatile function from writing'
    else 'ok'
  end as chat_query_read_only_txn;

-- ── Ask SILO request identity (20260916121000) ────────────────────────
-- Without request_id the chat page's crash-recovery path matches on question
-- TEXT, which repeats inside a conversation ("yes", "keep going") and which
-- the exec-visibility select policy does not scope to the reader -- so a
-- dropped request can recover somebody else's answer, or an earlier turn's.
-- The view carries an explicit column list, so a `create or replace` that
-- drops the column does not error; it just makes recovery silently impossible
-- again. Both halves are checked.
select
  case
    when to_regclass('public.silo_chat_audit_log') is null
      then 'MISSING — silo_chat_audit_log does not exist'
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='silo_chat_audit_log'
                       and column_name='request_id')
      then 'MISSING — run 20260916121000_silo_chat_audit_request_id.sql'
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='silo_chat_audit_log_v'
                       and column_name='request_id')
      then 'CRITICAL — silo_chat_audit_log_v lost request_id; chat crash-recovery falls back to matching question text'
    when not exists (select 1 from pg_indexes
                     where schemaname='public' and tablename='silo_chat_audit_log'
                       and indexname='silo_chat_audit_log_request_idx')
      then 'MISSING — silo_chat_audit_log_request_idx is absent; recovery lookups scan the log'
    else 'ok'
  end as chat_audit_request_id;

-- ── Top Sellers variance RPC (20260826120000) ─────────────────────────
select
  case
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='top_sellers_type_variance')
      then 'MISSING — run 20260826120000_top_sellers_type_variance.sql'
    when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                 where n.nspname='public' and p.proname='top_sellers_type_variance' and p.prosecdef)
      then 'MISSING — top_sellers_type_variance became SECURITY DEFINER; it must stay INVOKER so RLS scopes it to the caller''s company'
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='top_sellers_type_variance'
                       and pg_get_functiondef(p.oid) like '%364%')
      then 'MISSING — the last-year window is not 364 days; 365 misaligns the weekdays and moves the number more than real demand does'
    else 'ok'
  end as top_sellers_type_variance;

-- ── Product-title sales rollup (20260826230000, materialized 20260907120000)
-- The view kept its name and columns; what changed underneath is that it now
-- reads a matview, so the tenant boundary moved from RLS to an explicit filter
-- in a definer wrapper. Both halves are asserted here, because either one
-- missing is a cross-company leak rather than a slow page:
--   * security_invoker MUST be false -- a security_invoker view over a matview
--     RAISES 42501 for every authenticated user (the demand_coverage_by_type_v
--     failure), it does not merely return fewer rows;
--   * the active_company_id() filter MUST be present -- without it the view
--     hands every company's sales to every user, since a matview has no RLS;
--   * the matview MUST NOT be granted to authenticated or anon (the global
--     `reports_runnable` check below catches the authenticated case for every
--     matview at once; this names the one this migration created).
select
  case
    when not exists (select 1 from information_schema.views
                     where table_schema='public' and table_name='sales_by_product_title_daily_v')
      then 'MISSING — run 20260826230000_sales_by_product_title_daily.sql'
    when not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
                     where n.nspname='public' and c.relname='sales_by_product_title_daily_mv'
                       and c.relkind='m')
      then 'MISSING — sales_by_product_title_daily_mv; run 20260907120000_sales_by_product_title_daily_mv.sql. '
        || 'Unmaterialized, max(day_date) over this view costs ~6.9s and the Top products report pays it on every run'
    when coalesce((select option_value from pg_options_to_table(
                     (select c.reloptions from pg_class c join pg_namespace n on n.oid=c.relnamespace
                       where n.nspname='public' and c.relname='sales_by_product_title_daily_v'))
                   where option_name='security_invoker'), 'true') <> 'false'
      then 'BROKEN — sales_by_product_title_daily_v is not security_invoker=false; it reads a matview, and as an invoker view it raises 42501 for every user'
    when not exists (select 1 from pg_views v
                     where v.schemaname='public' and v.viewname='sales_by_product_title_daily_v'
                       and v.definition like '%active_company_id()%')
      then 'BROKEN — sales_by_product_title_daily_v lost its active_company_id() filter; a matview has no RLS, so it is now showing every company''s sales to every user'
    when has_table_privilege('anon', 'public.sales_by_product_title_daily_mv', 'SELECT')
      or has_table_privilege('authenticated', 'public.sales_by_product_title_daily_mv', 'SELECT')
      then 'BROKEN — sales_by_product_title_daily_mv is granted to anon or authenticated; the matview carries no RLS, so that is every company''s sales'
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='sales_by_product_title_daily_v'
                       and column_name='title_source')
      then 'MISSING — title_source dropped; unmatched SKUs would become indistinguishable from resolved ones'
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='refresh_sales_by_product_title_mv')
      then 'MISSING — refresh_sales_by_product_title_mv(); the rollup would freeze at whatever the migration populated'
    else 'ok'
  end as sales_by_product_title_daily_v;

-- ── Week over Week report RPC (20260826130000) ────────────────────────
select
  case
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='wow_report')
      then 'MISSING — run 20260826130000_wow_report_rpc.sql'
    when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                 where n.nspname='public' and p.proname='wow_report' and p.prosecdef)
      then 'MISSING — wow_report became SECURITY DEFINER; it must stay INVOKER so RLS scopes it'
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='wow_report'
                       and pg_get_functiondef(p.oid) like '%distinct on (variant_sku)%')
      then 'MISSING — inventory de-duplication dropped; the matview has duplicate sku/location rows and a naive sum overstates online units by ~5%'
    -- The 364-day rule moved into wow_window (20260901120000) when the report
    -- gained day/month/YTD grains, so it is checked there rather than in
    -- wow_report's own text. It still has to hold: 365 lands the comparison
    -- window on different weekdays, which moves a 7-day number more than real
    -- demand does.
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='wow_window'
                       and pg_get_functiondef(p.oid) like '%364%')
      then 'MISSING — wow_window last-year offset is not 364 days; 365 misaligns the weekdays'
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='wow_report'
                       and pg_get_functiondef(p.oid) like '%wow_window(p_report_date, p_grain)%')
      then 'MISSING — wow_report no longer delegates its window to wow_window; the grain selector would move the headline and nothing else'
    else 'ok'
  end as wow_report_rpc;

-- ── Week over Week written half (20260826140000) ──────────────────────
select
  case
    when not exists (select 1 from information_schema.tables
                     where table_schema='public' and table_name='wow_report_entries')
      then 'MISSING — run 20260826140000_wow_report_entries.sql'
    when not (select relrowsecurity from pg_class where oid='public.wow_report_entries'::regclass)
      then 'MISSING — RLS not enabled on wow_report_entries'
    when (select count(*) from pg_policies where schemaname='public' and tablename='wow_report_entries') < 3
      then 'MISSING — wow_report_entries needs select/insert/update policies'
    when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                 where n.nspname='public' and p.proname='wow_report'
                   and pg_get_functiondef(p.oid) like '%inventory_on_hand_current_mv%')
      then 'MISSING — wow_report reads the matview directly; authenticated has no grant on it and it is not company-scoped. Use inventory_on_hand_current_v'
    else 'ok'
  end as wow_report_entries;

-- ── Week over Week period grains (20260901120000) ─────────────────────
select
  case
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='wow_window')
      then 'MISSING — run 20260901120000_wow_grain_windows.sql'
    -- ROWS 1 is not cosmetic. A set-returning function defaults to an estimate
    -- of 1000 rows and every report RPC joins this one as `cross join w`, so
    -- losing it multiplies every downstream row estimate by 1000 and the
    -- report starts timing out rather than returning a wrong answer.
    when (select prorows from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname='wow_window') <> 1
      then 'MISSING — wow_window lost ROWS 1; the planner will estimate 1000 rows per cross join w and the report RPCs will time out'
    -- Every report RPC must take the grain AND actually delegate its window to
    -- wow_window. One that quietly kept its own hand-typed 7-day CTE would
    -- render under a "Month to date" heading while measuring a week.
    when exists (select 1 from unnest(array['wow_report','wow_kpi_compare','wow_funnel','wow_landing_pages',
                                            'wow_discount_codes','wow_paid_media','wow_paid_media_not_synced',
                                            'wow_paid_media_reality']) fn
                 where not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                                   where n.nspname='public' and p.proname=fn
                                     and pg_get_function_identity_arguments(p.oid) like '%p_grain%'
                                     and pg_get_functiondef(p.oid) like '%wow_window(p_report_date, p_grain)%'))
      then 'MISSING — a wow_* report RPC is not on wow_window; its window would disagree with the rest of the report'
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='wow_report_entries' and column_name='grain')
      then 'MISSING — wow_report_entries.grain; notes for a day and a week on the same date would overwrite each other'
    when not exists (select 1 from pg_indexes where schemaname='public'
                       and tablename='wow_report_entries'
                       and indexdef like '%(company_entity_id, report_date, grain)%')
      then 'MISSING — the (company, report_date, grain) unique index; the page upserts on that conflict target'
    else 'ok'
  end as wow_report_grains;

-- ── Week over Week sbd column list (20260901130000) ───────────────────
-- Not a style check. `select s.*` in these CTEs materialises ~30 columns of a
-- 1.1M-row table when eight are read, and at YTD that alone was the difference
-- between 3.67s and 0.83s over the same rows -- enough to push wow_report past
-- the 8s statement_timeout `authenticated` carries and fail the page outright.
-- A migration that rebuilds either function from the older repo text would
-- reintroduce it, and the symptom (only the widest grain fails, only for real
-- users, never for a superuser connection) is expensive to rediscover.
select
  case
    when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                 where n.nspname='public' and p.proname in ('wow_report','wow_kpi_compare')
                   and pg_get_functiondef(p.oid) like '%select s.* from public.sales_by_day s%')
      then 'MISSING — a wow_* sbd CTE is back to select s.*; YTD will exceed the 8s authenticated statement_timeout. Run 20260901130000_wow_narrow_sbd_cte.sql'
    else 'ok'
  end as wow_sbd_narrow;

-- ── Week over Week sales rollup (20260901140000) ──────────────────────
-- The report reads its sales figures from a rollup because seven RPCs firing
-- in parallel over sales_by_day blew the 8s authenticated statement_timeout on
-- all of them at once at YTD. Four things have to stay true or that returns,
-- or worse.
select
  case
    when not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
                     where n.nspname='public' and c.relname='wow_sales_daily_type_mv' and c.relkind='m')
      then 'MISSING — run 20260901140000_wow_sales_daily_rollup.sql'
    -- Without a unique index the nightly REFRESH cannot run CONCURRENTLY and
    -- takes an AccessExclusiveLock, blocking every reader while it rebuilds.
    when not exists (select 1 from pg_indexes where schemaname='public'
                       and tablename='wow_sales_daily_type_mv'
                       and indexdef like '%UNIQUE%')
      then 'MISSING — wow_sales_daily_type_mv has no unique index; CONCURRENTLY refresh is impossible and the nightly refresh will lock out readers'
    -- security_invoker MUST stay false. The matview carries no RLS and
    -- authenticated holds no grant on it, so an invoker view would fail at
    -- runtime -- and if the grant were then "fixed", it would serve every
    -- company's sales to every caller.
    when coalesce((select option_value from pg_class c
                     join pg_namespace n on n.oid=c.relnamespace,
                   lateral pg_options_to_table(c.reloptions)
                   where n.nspname='public' and c.relname='wow_sales_daily_type_v'
                     and option_name='security_invoker'), 'true') <> 'false'
      then 'MISSING — wow_sales_daily_type_v is not security_invoker=false; it reads a matview that has no RLS'
    when (select count(*) from information_schema.role_table_grants
          where table_schema='public' and table_name='wow_sales_daily_type_mv'
            and grantee in ('anon','authenticated')) > 0
      then 'MISSING — the wow rollup matview is granted to anon/authenticated; it carries no RLS and no company filter. Read it through wow_sales_daily_type_v'
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='refresh_wow_sales_daily_mv' and p.prosecdef)
      then 'MISSING — refresh_wow_sales_daily_mv() absent or not SECURITY DEFINER; the nightly sync cannot refresh the rollup and the report would serve stale sales'
    when exists (select 1 from unnest(array['wow_report','wow_kpi_compare']) fn
                 where not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                                   where n.nspname='public' and p.proname=fn
                                     and pg_get_functiondef(p.oid) like '%wow_sales_daily_type_v%'))
      then 'MISSING — wow_report or wow_kpi_compare is back on sales_by_day directly; YTD will exceed the 8s statement_timeout under the page''s parallel load'
    else 'ok'
  end as wow_sales_rollup;

-- ── Week over Week organic posts (20260901150000) ─────────────────────
select
  case
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='wow_organic_posts')
      then 'MISSING — run 20260901150000_wow_organic_posts.sql'
    -- SECURITY INVOKER or instagram_media_insights' RLS stops scoping it to
    -- the caller's company, exactly as for wow_report.
    when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                 where n.nspname='public' and p.proname='wow_organic_posts' and p.prosecdef)
      then 'MISSING — wow_organic_posts became SECURITY DEFINER; it must stay INVOKER so RLS scopes it'
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='wow_organic_posts'
                       and pg_get_functiondef(p.oid) like '%wow_window(p_report_date, p_grain)%')
      then 'MISSING — wow_organic_posts does not delegate its window to wow_window; organic would describe a different period than the rest of the report'
    -- history_starts is what lets the page mark a window partial. Organic data
    -- begins 2026-05-21, so a YTD window asks for January and gets May onward;
    -- without this the card prints a confident total that is most of a year short.
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='wow_organic_posts'
                       and pg_get_functiondef(p.oid) like '%history_starts%')
      then 'MISSING — wow_organic_posts no longer returns history_starts; a YTD organic total silently short by months would render as complete'
    -- engagement_rate must divide by reach (people), never views (plays).
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='wow_organic_posts'
                       and pg_get_functiondef(p.oid) like '%engagement::numeric/reach%')
      then 'MISSING — engagement_rate no longer divides by reach; dividing by views measures plays, not people, and understates every post'
    else 'ok'
  end as wow_organic_posts;

-- ── Meta objectives + ad-level creatives (20260901160000/170000) ──────
select
  case
    -- Followers must stay its own objective, matched BEFORE subscribers. A
    -- follower buy reports follows, never leads, so folding it back into
    -- subscribers makes that group's cost-per-lead meaningless -- which is why
    -- the code carried a spend_without_leads workaround before the split.
    when public.meta_campaign_group('Instagram Followers 12/30 Activation') <> 'followers'
      then 'MISSING — followers are grouped as subscribers again; run 20260901160000_meta_followers_group.sql'
    when public.meta_campaign_group('Subscribers') <> 'subscribers'
      then 'MISSING — the followers branch is swallowing subscriber campaigns'
    -- Thruplay is matched first on purpose: a video-views campaign with
    -- "followers" in its name is a thruplay buy.
    when public.meta_campaign_group('Max Thru Plays Brand Promotion - Upper Funnel') <> 'thruplay'
      then 'MISSING — thruplay no longer matched first'
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='wow_creatives')
      then 'MISSING — run 20260901170000_wow_creatives.sql'
    when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                 where n.nspname='public' and p.proname='wow_creatives' and p.prosecdef)
      then 'MISSING — wow_creatives became SECURITY DEFINER; it must stay INVOKER so RLS scopes it'
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='wow_creatives'
                       and pg_get_functiondef(p.oid) like '%wow_window(p_report_date, p_grain)%')
      then 'MISSING — wow_creatives does not delegate its window to wow_window'
    -- "Live in the period" is spend > 0, never effective_status: status is the
    -- ad's state NOW, so filtering on it deletes ads retroactively as they are
    -- paused and quietly shrinks last week's report every day.
    when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                 where n.nspname='public' and p.proname='wow_creatives'
                   and pg_get_functiondef(p.oid) ~ 'where[^;]*effective_status[[:space:]]*=')
      then 'MISSING — wow_creatives filters on effective_status; that drops every ad that ran in the window and has since been paused'
    else 'ok'
  end as wow_creatives;

-- ── Storefront status on products_master (20260901180000) ─────────────
-- Sammie asked "is this product live on the website" six different ways in the
-- Ask SILO log and the honest answer was no: is_active is true on all 24,056
-- rows, is_discontinued has never been set, lifecycle_status only carries PO
-- states, and created_at is a bulk-load date on 98% of rows. These two columns
-- are the answer, and the catalog note is what stops the next person repeating
-- those six rounds.
select
  case
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='products_master'
                       and column_name='shopify_status')
      then 'MISSING — run 20260901180000_products_shopify_status.sql'
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='products_master'
                       and column_name='online_published_at')
      then 'MISSING — products_master.online_published_at; "live on the site" needs the publication date as well as the status'
    when not exists (select 1 from public.silo_chat_schema_catalog
                     where relname='products_master' and description like '%shopify_status%')
      then 'MISSING — the products_master catalog note does not mention shopify_status; Ask SILO will keep answering "no such field" and steer people to is_active, which is true on every row'
    else 'ok'
  end as products_storefront_status;

-- ── Shopify sessions / funnel (20260826150000) ────────────────────────
select
  case
    when not exists (select 1 from information_schema.tables
                     where table_schema='public' and table_name='shopify_sessions_daily')
      then 'MISSING — run 20260826150000_shopify_sessions_daily.sql'
    when not exists (select 1 from information_schema.tables
                     where table_schema='public' and table_name='shopify_customer_metrics_daily')
      then 'MISSING — shopify_customer_metrics_daily not created'
    when not exists (select 1 from information_schema.views
                     where table_schema='public' and table_name='shopify_funnel_daily_v')
      then 'MISSING — shopify_funnel_daily_v not created'
    when exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='shopify_sessions_daily'
                   and column_name in ('conversion_rate','cart_rate'))
      then 'MISSING — a rate column was added to shopify_sessions_daily; store counts only, derive rates in shopify_funnel_daily_v or a weekly roll-up will average percentages'
    when not exists (select 1 from pg_constraint
                     where conname='sync_jobs_job_type_check'
                       and pg_get_constraintdef(oid) like '%sessions_sync%')
      then 'MISSING — sync_jobs job_type check does not allow sessions_sync; the nightly job will fail to log'
    else 'ok'
  end as shopify_sessions_sync;

-- ── Paid-media reality check (20260827180000) ─────────────────────────
select
  case
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='wow_paid_media_reality')
      then 'MISSING — run 20260827180000_paid_media_reality_check.sql'
    -- Matches an actual FROM clause, not the word in the function's own
    -- comment warning against it -- the first cut of this check matched the
    -- comment and reported MISSING on a correct function.
    when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                 where n.nspname='public' and p.proname='wow_paid_media_reality'
                   and pg_get_functiondef(p.oid) ~* 'from\s+public\.shopify_orders')
      then 'MISSING — wow_paid_media_reality reads shopify_orders for new customers; that table is partial backfills (Aug-Oct 2025, Jan/Mar 2026 absent) and would count a returning customer as new. Use shopify_customer_metrics_daily'
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='wow_paid_media_reality'
                       and pg_get_functiondef(p.oid) like '%shopify_customer_metrics_daily%')
      then 'MISSING — wow_paid_media_reality no longer reads shopify_customer_metrics_daily; new-customer counts must come from ShopifyQL, not reconstructed'
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='wow_paid_media_reality'
                       and pg_get_functiondef(p.oid) like '%tiktok_ads%')
      then 'MISSING — wow_paid_media_reality no longer allowlists platforms; it must name the ad platforms explicitly so ga4 (analytics, not an ad platform) stays out of spend and claimed-revenue rollups'
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='ad_platforms_expected'
                       and p.prosecdef)
      then 'MISSING — ad_platforms_expected() absent or no longer SECURITY DEFINER; without it a non-admin reads zero ad_platform_connections rows and platforms_not_synced is permanently empty for them'
    when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                 where n.nspname='public' and p.proname='wow_paid_media_reality'
                   and pg_get_functiondef(p.oid) like '%unnest(array[%')
      then 'MISSING — wow_paid_media_reality hardcodes the platform list again; derive it from ad_platforms_expected() so an unconnected platform is not reported as a failed sync forever'
    when not exists (select 1 from public.silo_chat_schema_catalog
                     where relname='marketing_kpis_daily'
                       and description like '%CLAIMED, NOT ACTUAL%')
      then 'MISSING — marketing_kpis_daily catalog note absent; Ask SILO will read conversion_value as revenue and sum it across platforms'
    else 'ok'
  end as paid_media_reality;

select
  case
    when not exists (
        select 1 from pg_constraint
         where conrelid = 'public.review_template_questions'::regclass
           and conname = 'review_template_questions_kind_check'
           and pg_get_constraintdef(oid) like '%scale_1_4%')
      then 'MISSING — review_template_questions.kind rejects scale_1_4; the template builder can no longer save a 1-4 rating question'
    when not exists (
        select 1 from pg_constraint
         where conrelid = 'public.review_template_questions'::regclass
           and conname = 'review_template_questions_kind_check'
           and pg_get_constraintdef(oid) like '%scale_1_10%')
      then 'MISSING — scale_1_10 was dropped from the kind check; historical 1-10 questions must keep their kind or every past score reprints out of 4'
    when exists (
        select 1 from public.review_template_questions q
         where q.kind = 'scale_1_10'
           and not exists (select 1 from public.review_answers a
                            where a.question_id = q.id
                              and coalesce((a.value ->> 'score')::numeric, 0) > 4))
      then 'MISSING — a scale_1_10 question with no out-of-range answers was not converted; re-run 20260827200000_review_scale_1_4_and_goal_dates.sql'
    when not exists (
        select 1 from pg_indexes
         where schemaname = 'public' and indexname = 'employee_goals_target_date_idx')
      then 'MISSING — employee_goals_target_date_idx absent; run 20260827200000_review_scale_1_4_and_goal_dates.sql'
    else 'ok'
  end as review_scale_1_4_and_goal_dates;

-- ---------------------------------------------------------------------------
-- Card coding (20260831180000_card_coding.sql)
-- ---------------------------------------------------------------------------
select
  case
    when not exists (select 1 from information_schema.tables
                      where table_schema='public' and table_name='card_sources')
      then 'MISSING — card_sources absent; run 20260831180000_card_coding.sql'
    when not exists (select 1 from information_schema.tables
                      where table_schema='public' and table_name='card_import_batches')
      then 'MISSING — card_import_batches absent; run 20260831180000_card_coding.sql'
    when not exists (select 1 from information_schema.tables
                      where table_schema='public' and table_name='card_transactions')
      then 'MISSING — card_transactions absent; run 20260831180000_card_coding.sql'
    when not exists (select 1 from information_schema.tables
                      where table_schema='public' and table_name='card_coding_rules')
      then 'MISSING — card_coding_rules absent; run 20260831180000_card_coding.sql'
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                      where n.nspname='public' and p.proname='can_manage_journal_entries')
      then 'MISSING — can_manage_journal_entries() absent; card coding RLS would deny everyone'
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                      where n.nspname='public' and p.proname='normalize_merchant')
      then 'MISSING — normalize_merchant() absent; coding rules cannot match'
    -- The browser mirrors this function. If the two disagree, rules stop
    -- matching silently, so the behaviour is asserted rather than assumed.
    when public.normalize_merchant('AMZN Mktp US*2A4XY9') is distinct from 'amzn mktp us'
      then 'MISSING — normalize_merchant() no longer strips a *reference code; every Amazon charge becomes its own merchant and no rule matches twice'
    when public.normalize_merchant('SQ *BLUE BOTTLE 0421') is distinct from 'blue bottle'
      then 'MISSING — normalize_merchant() no longer strips the SQ * processor prefix'
    when public.normalize_merchant('ADOBE  *ACROPRO SUBS') is distinct from 'adobe acropro subs'
      then 'MISSING — normalize_merchant() is over-stripping; a product name after * must survive'
    when not exists (select 1 from pg_views where schemaname='public' and viewname='card_transactions_v')
      then 'MISSING — card_transactions_v absent'
    when not exists (select 1 from pg_views where schemaname='public' and viewname='card_import_batches_v')
      then 'MISSING — card_import_batches_v absent'
    when not exists (select 1 from pg_policies
                      where schemaname='public' and tablename='card_transactions'
                        and policyname='card_transactions_write_draft'
                        and qual like '%draft%' and qual like '%categorized%'
                        and with_check like '%draft%' and with_check like '%categorized%')
      then 'MISSING — transaction writes must be restricted to draft and categorized batches'
    else 'ok'
  end as card_coding;

-- ---------------------------------------------------------------------------
-- Card name / cardholder (20260831190000_card_name_and_holder.sql)
-- ---------------------------------------------------------------------------
select
  case
    when not exists (select 1 from information_schema.columns
                      where table_schema='public' and table_name='card_transactions'
                        and column_name='card_name')
      then 'MISSING — card_transactions.card_name absent; run 20260831190000_card_name_and_holder.sql'
    when not exists (select 1 from information_schema.columns
                      where table_schema='public' and table_name='card_transactions'
                        and column_name='clean_merchant')
      then 'MISSING — card_transactions.clean_merchant absent'
    when not exists (select 1 from information_schema.columns
                      where table_schema='public' and table_name='card_coding_rules'
                        and column_name='match_field')
      then 'MISSING — card_coding_rules.match_field absent; card-name rules cannot be stored'
    -- The view must prefer the issuer's cleaned name, or a rule learned on a
    -- Divvy row keyed 'amazon' silently stops matching.
    when (select pg_get_viewdef('public.card_transactions_v'::regclass)) not like '%clean_merchant%'
      then 'MISSING — card_transactions_v no longer keys merchant_norm off clean_merchant'
    else 'ok'
  end as card_name_and_holder;

-- ---------------------------------------------------------------------------
-- QBO entities / per-line entity (20260831200000_qbo_entities_and_line_entity.sql)
-- ---------------------------------------------------------------------------
select
  case
    when not exists (select 1 from information_schema.tables
                      where table_schema='public' and table_name='quickbooks_customers')
      then 'MISSING — quickbooks_customers absent; intercompany receivable lines have no entity to name'
    when not exists (select 1 from information_schema.tables
                      where table_schema='public' and table_name='quickbooks_vendors')
      then 'MISSING — quickbooks_vendors absent'
    when not exists (select 1 from information_schema.columns
                      where table_schema='public' and table_name='card_transactions'
                        and column_name='entity_qbo_id')
      then 'MISSING — card_transactions.entity_qbo_id absent'
    when not exists (select 1 from information_schema.columns
                      where table_schema='public' and table_name='card_coding_rules'
                        and column_name='entity_qbo_id')
      then 'MISSING — card_coding_rules.entity_qbo_id absent; a learned rule loses its entity'
    when public.qbo_account_needs_entity('Accounts Receivable') is not true
      then 'MISSING — qbo_account_needs_entity() no longer flags AR; QuickBooks would reject the entry'
    when public.qbo_account_needs_entity('Expense') is not false
      then 'MISSING — qbo_account_needs_entity() flags plain expenses; every row would demand an entity'
    else 'ok'
  end as qbo_entities_and_line_entity;

-- ---------------------------------------------------------------------------
-- Card coding save path (20260831210000_apply_card_coding_rpc.sql)
-- ---------------------------------------------------------------------------
select
  case
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname='public' and p.proname='apply_card_coding')
      then 'MISSING — apply_card_coding() absent; the coding page cannot save'
    -- SECURITY DEFINER here would bypass card_transactions_write entirely,
    -- including its refusal to touch a posted batch.
    when (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='apply_card_coding')
      then 'MISSING — apply_card_coding() is SECURITY DEFINER; it must run as the caller so RLS still applies'
    else 'ok'
  end as apply_card_coding;

-- ---------------------------------------------------------------------------
-- Voiding a posted card batch (20260831220000_void_card_posting.sql)
-- ---------------------------------------------------------------------------
select
  case
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname='public' and p.proname='void_card_posting')
      then 'MISSING — void_card_posting() absent; an entry deleted in QuickBooks leaves the batch '
        || 'permanently unpostable, because the double-post index only releases on a non-posted row'
    -- quickbooks_journal_postings must stay closed to client writes: this
    -- function is the only sanctioned way in, and it can only void.
    when exists (select 1 from pg_policies
                  where schemaname='public' and tablename='quickbooks_journal_postings'
                    and cmd in ('ALL','UPDATE','INSERT','DELETE'))
      then 'MISSING — quickbooks_journal_postings has a client write policy; what SILO believes it '
        || 'sent to Intuit must not be rewritable from a browser'
    else 'ok'
  end as void_card_posting;

-- ---------------------------------------------------------------------------
-- Rule hits and card-vs-merchant conflicts (20260831230000)
-- ---------------------------------------------------------------------------
select
  case
    when not exists (select 1 from information_schema.columns
                      where table_schema='public' and table_name='card_transactions'
                        and column_name='coding_conflict')
      then 'MISSING — card_transactions.coding_conflict absent; a row whose card and merchant '
        || 'disagree would be auto-coded from the merchant instead of held back'
    when (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='apply_card_coding') not like '%hit_count%'
      then 'MISSING — apply_card_coding() no longer bumps hit_count; the Used column on the '
        || 'Rules tab reverts to always reading 0'
    else 'ok'
  end as rule_hits_and_conflicts;

-- ---------------------------------------------------------------------------
-- Journal adjustments (20260901000000, 20260901010000, 20260901020000)
-- ---------------------------------------------------------------------------
select
  case
    when not exists (select 1 from information_schema.tables
                      where table_schema='public' and table_name='journal_adjustments')
      then 'MISSING — journal_adjustments absent; run 20260901000000_journal_adjustments.sql'
    when not exists (select 1 from information_schema.tables
                      where table_schema='public' and table_name='journal_adjustment_lines')
      then 'MISSING — journal_adjustment_lines absent'
    when not exists (select 1 from pg_views
                      where schemaname='public' and viewname='journal_adjustments_v')
      then 'MISSING — journal_adjustments_v absent; the Adjustments card on '
        || '/v2/qbo-reports.html renders from it'
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname='public' and p.proname='void_journal_adjustment')
      then 'MISSING — void_journal_adjustment() absent; an adjustment whose entry was deleted in '
        || 'QuickBooks becomes permanently unpostable, exactly as card batches did before '
        || 'void_card_posting existed'
    -- The half-guard that shipped first: USING alone refuses to EDIT a posted
    -- row but says nothing about the row being WRITTEN, so a draft could be
    -- moved straight to 'posted' from a browser and SILO would then claim an
    -- entry Intuit never received. Both halves must carry the status clause.
    when exists (
      select 1 from pg_policies
       where schemaname='public'
         and tablename in ('journal_adjustments','card_import_batches')
         and cmd = 'ALL'
         and with_check not like '%posted%')
      then 'MISSING — a posting-status WITH CHECK is absent; a finance user could mark an entry '
        || 'posted from the browser without it ever reaching QuickBooks'
    else 'ok'
  end as journal_adjustments;

-- ---------------------------------------------------------------------------
-- Fixed assets (20260902030000_fixed_assets.sql)
-- ---------------------------------------------------------------------------
select
  case
    when not exists (select 1 from information_schema.tables
                      where table_schema='public' and table_name='fixed_assets')
      then 'MISSING — fixed_assets absent; run 20260902030000_fixed_assets.sql'
    when not exists (select 1 from pg_views
                      where schemaname='public' and viewname='fixed_asset_depreciation_v')
      then 'MISSING — fixed_asset_depreciation_v absent; /v2/fixed-assets.html has nothing to post'
    when not exists (select 1 from pg_views
                      where schemaname='public' and viewname='fixed_asset_balances_v')
      then 'MISSING — fixed_asset_balances_v absent; the asset register cannot show net book value'
    -- The divisor bug caught before this shipped: an early disposal must
    -- never force-recognise the remaining depreciable base in the months
    -- actually served (a 24-month/$24,000 asset disposed after 6 months
    -- was recognising the full $24,000 in those 6 months instead of
    -- $6,000). Structural only -- this file stays read-only, so it checks
    -- the view still divides by useful_life_months rather than re-deriving
    -- a period count, not the live arithmetic.
    when (select pg_get_viewdef('public.fixed_asset_depreciation_v'::regclass))
         not like '%nominal_months%'
      then 'MISSING — fixed_asset_depreciation_v no longer names nominal_months as its own concept; '
        || 'check it still divides by useful_life_months rather than the disposal-shortened period '
        || 'count (verified directly against synthetic assets when this view was built: a 24mo/'
        || '$24,000 asset disposed after 6mo must recognise $6,000, not $24,000)'
    -- 20260903190000: a landlord TI reimbursement is its own contra-asset,
    -- amortizing to zero on the same straight-line schedule as any other
    -- asset -- not netted against a specific positive row. That needs
    -- cost <> 0 (was > 0); a cost = 0 constraint violation here means the
    -- widening migration never ran and an AssetGuru-style import will fail.
    when exists (select 1 from pg_constraint
                 where conrelid = 'public.fixed_assets'::regclass
                   and conname = 'fixed_assets_cost_check'
                   and pg_get_constraintdef(oid) not like '%cost <> 0%'
                   and pg_get_constraintdef(oid) not like '%cost <> (0)%')
      then 'MISSING — fixed_assets_cost_check still reads cost > 0; '
        || 'run 20260903190000_fixed_assets_negative_cost.sql so a negative-cost '
        || 'contra-asset (e.g. a landlord TI reimbursement) can be inserted'
    else 'ok'
  end as fixed_assets;
-- ── Storage isolation ────────────────────────────────────────────────
-- Storage RLS is easy to forget because it lives in another schema and is
-- not touched by any normal migration. Before 20260904120000 all 27 policies
-- on storage.objects gated on bucket_id ALONE -- so every authenticated user
-- of every company could read and delete all 375 payment-request
-- attachments and all 51 mailroom scans. This asserts the private buckets
-- have not drifted back.
--
-- The test is that every command on a private bucket names its parent table.
-- A policy mentioning only its bucket is the exact shape of the bug.
select
  case
    when exists (
      select 1 from pg_policies
       where schemaname='storage' and tablename='objects'
         and coalesce(qual,'') || ' ' || coalesce(with_check,'') like '%payment-request-files%'
         and coalesce(qual,'') || ' ' || coalesce(with_check,'') !~* 'payment_requests'
    ) then 'BROKEN — a payment-request-files policy does not check the parent request; every company can read every invoice'
    when exists (
      select 1 from pg_policies
       where schemaname='storage' and tablename='objects'
         and coalesce(qual,'') || ' ' || coalesce(with_check,'') like '%mail-item-files%'
         and coalesce(qual,'') || ' ' || coalesce(with_check,'') !~* 'mail_items'
    ) then 'BROKEN — a mail-item-files policy does not check the parent mail item'
    when exists (
      select 1 from pg_policies
       where schemaname='storage' and tablename='objects'
         and coalesce(qual,'') || ' ' || coalesce(with_check,'') like '%schedule-item-files%'
         and coalesce(qual,'') || ' ' || coalesce(with_check,'') !~* 'schedule_items'
    ) then 'BROKEN — a schedule-item-files policy does not check the parent schedule item'
    -- Four each: select, insert, update, delete. A missing one means a
    -- command fell back to no policy at all, which storage denies -- a
    -- broken feature rather than a leak, but still wrong.
    when (select count(*) from pg_policies
           where schemaname='storage' and tablename='objects'
             and coalesce(qual,'') || ' ' || coalesce(with_check,'') like '%payment-request-files%') < 4
      then 'MISSING — payment-request-files is short a policy; uploads or downloads will fail'
    else 'ok'
  end as storage_isolation;

select
  case
    when not exists (select 1 from information_schema.tables
                     where table_schema='public' and table_name='dashboards')
      then 'MISSING — run 20260828120000_v3_dashboards.sql'
    when not exists (select 1 from information_schema.tables
                     where table_schema='public' and table_name='dashboard_widgets')
      then 'MISSING — dashboard_widgets table'
    when not exists (select 1 from pg_policies
                     where schemaname='public' and tablename='dashboards'
                       and policyname='dashboards_select')
      then 'MISSING — dashboards RLS policies'
    when not exists (select 1 from pg_policies
                     where schemaname='public' and tablename='dashboard_widgets'
                       and policyname='dashboard_widgets_select')
      then 'MISSING — dashboard_widgets RLS policies'
    when not exists (select 1 from pg_trigger
                     where tgrelid='public.dashboard_widgets'::regclass
                       and tgname='stamp_company_entity_id')
      then 'MISSING — stamp_company_entity_id trigger on dashboard_widgets; re-run attach_stamp_company_entity_id_triggers()'
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='dashboard_widgets_v'
                       and column_name='query_sql')
      then 'MISSING — dashboard_widgets_v.query_sql; every widget renders "source report not visible" without it'
    when not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
                     where n.nspname='public' and c.relname='dashboard_widgets_v'
                       and c.reloptions::text like '%security_invoker%')
      then 'MISSING — dashboard_widgets_v is not security_invoker; it would hand a private report''s SQL to every viewer'
    -- The visual_type CHECK is the ONE part of a visual that needs a
    -- migration; a stale one rejects every save of a board using a newer
    -- visual, and the page reports it as a failed save with no clue why.
    when not exists (select 1 from pg_constraint
                     where conrelid='public.dashboard_widgets'::regclass
                       and conname='dashboard_widgets_visual_type_check'
                       and pg_get_constraintdef(oid) like '%matrix%'
                       and pg_get_constraintdef(oid) like '%section%'
                       and pg_get_constraintdef(oid) like '%answer%')
      then 'MISSING — dashboard_widgets.visual_type CHECK does not admit matrix/section/answer; run 20260903200000, 20260903210000 and 20260904340000'
    when not exists (select 1 from pg_constraint
                     where conrelid='public.dashboard_widgets'::regclass
                       and conname='dashboard_widgets_visual_type_check'
                       and pg_get_constraintdef(oid) like '%heatmap%'
                       and pg_get_constraintdef(oid) like '%waterfall%'
                       and pg_get_constraintdef(oid) like '%combo%')
      then 'MISSING — dashboard_widgets.visual_type CHECK does not admit combo/heatmap/waterfall; run 20260908140000'
    when not exists (select 1 from pg_constraint
                     where conrelid='public.dashboard_widgets'::regclass
                       and conname='dashboard_widgets_section_has_title')
      then 'MISSING — dashboard_widgets_section_has_title; an untitled section is an invisible tile that still takes grid space'
    -- The inverse guard: an answer widget with no report has no text to
    -- render at all, an empty tile that looks broken rather than an
    -- intentional heading the way an untitled section would.
    when not exists (select 1 from pg_constraint
                     where conrelid='public.dashboard_widgets'::regclass
                       and conname='dashboard_widgets_answer_has_report')
      then 'MISSING — dashboard_widgets_answer_has_report; an answer widget with no report_id renders nothing'
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='dashboard_widgets_v'
                       and column_name='report_answer')
      then 'MISSING — dashboard_widgets_v.report_answer; the answer widget would have no text to render. Run 20260904340000_answer_widget.sql'
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='silo_chat_saved_reports'
                       and column_name='builder_config')
      then 'MISSING — silo_chat_saved_reports.builder_config; every guided report would reopen as raw SQL'
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='saved_report_usage')
      then 'MISSING — saved_report_usage(); the report editor would save with no idea how many tiles it changes'
    -- SECURITY DEFINER is the whole point of that function: dashboard_widgets
    -- RLS hides widgets on dashboards the caller cannot see, and an
    -- undercount in a blast-radius warning reads as safety.
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='saved_report_usage' and p.prosecdef)
      then 'BROKEN — saved_report_usage() is not SECURITY DEFINER; it would undercount widgets on dashboards the caller cannot see'
    else 'ok'
  end as v3_dashboards;

-- ── Personal saved filter views (20260908130000) ─────────────────────
-- A dashboard's own filter_state is the SHARED position. These are one
-- person's cut of the same board, which previously required duplicating the
-- board and its widgets.
--
-- The RLS check is the one that matters: the select policy has to be
-- creator-only. A widened one would put every colleague's working filters on
-- everyone's board, and unlike most policy drift it would look like a
-- feature rather than a leak.
select
  case
    when not exists (select 1 from information_schema.tables
                     where table_schema='public' and table_name='dashboard_filter_views')
      then 'MISSING — run 20260908130000_dashboard_filter_views.sql (the page hides the control without it, it does not break)'
    when not exists (select 1 from pg_policies
                     where schemaname='public' and tablename='dashboard_filter_views'
                       and policyname='dashboard_filter_views_select'
                       and qual like '%created_by = auth.uid()%')
      then 'BROKEN — dashboard_filter_views_select is not creator-only; every saved cut would be visible company-wide'
    when (select count(*) from pg_policies
           where schemaname='public' and tablename='dashboard_filter_views') < 4
      then 'MISSING — dashboard_filter_views is short a policy; saving or deleting a view will fail'
    when not exists (select 1 from pg_trigger
                     where tgrelid='public.dashboard_filter_views'::regclass
                       and tgname='stamp_company_entity_id')
      then 'MISSING — stamp_company_entity_id on dashboard_filter_views; every insert would be refused by its own WITH CHECK'
    -- Saving over "My stores" must REPLACE it. Without this index the upsert
    -- has no conflict target and a list grows three entries with one name.
    when not exists (select 1 from pg_indexes
                     where schemaname='public' and tablename='dashboard_filter_views'
                       and indexname='dashboard_filter_views_owner_name_idx')
      then 'MISSING — dashboard_filter_views_owner_name_idx; saving a view over its own name would add a duplicate instead'
    else 'ok'
  end as v3_filter_views;

-- ── How big is a report? (20260907140000) ────────────────────────────
-- The runner pages at 1000 rows. Every surface that RENDERS a report is
-- honest about that already; nothing told the AUTHOR before the report was
-- on somebody's dashboard. These two columns are that record.
--
-- The view check is the one that actually breaks silently:
-- silo_chat_saved_reports_v carries an EXPLICIT column list, so a `create or
-- replace` that forgets these columns does not error -- the picker just stops
-- showing sizes and every report looks small again.
select
  case
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='silo_chat_saved_reports'
                       and column_name='row_estimate')
      then 'MISSING — run 20260907140000_report_row_estimate.sql'
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='silo_chat_saved_reports'
                       and column_name='row_estimate_at')
      then 'MISSING — row_estimate_at; a count with no date on it is not interpretable'
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='silo_chat_saved_reports_v'
                       and column_name='row_estimate')
      then 'BROKEN — silo_chat_saved_reports_v does not expose row_estimate. The view has an '
        || 'explicit column list, so the picker silently shows no sizes and every oversized '
        || 'report looks small'
    when coalesce((select option_value from pg_options_to_table(
                     (select c.reloptions from pg_class c join pg_namespace n on n.oid=c.relnamespace
                       where n.nspname='public' and c.relname='silo_chat_saved_reports_v'))
                   where option_name='security_invoker'), 'false') <> 'true'
      then 'BROKEN — silo_chat_saved_reports_v lost security_invoker; it would hand every '
        || 'company''s saved reports to every user'
    when has_table_privilege('anon','public.silo_chat_saved_reports_v','SELECT')
      then 'BROKEN — anon can select silo_chat_saved_reports_v'
    -- A stored estimate that is not a count is worse than none: the whole
    -- point of the column is that the number can be trusted.
    when exists (select 1 from public.silo_chat_saved_reports
                 where row_estimate is not null and row_estimate < 0)
      then 'BROKEN — a negative row_estimate exists'
    when exists (select 1 from public.silo_chat_saved_reports
                 where (row_estimate is null) <> (row_estimate_at is null))
      then 'BROKEN — row_estimate and row_estimate_at disagree about whether a measurement '
        || 'exists; neither means anything without the other'
    else 'ok'
  end as report_row_estimate;

-- ── Reports that cannot run ──────────────────────────────────────────
-- A saved report reading a MATERIALIZED VIEW from a security_invoker view
-- does not return fewer rows -- it RAISES 42501, because a matview has no
-- RLS and is therefore not granted to `authenticated`. That is how
-- demand_coverage_by_type_v was broken for every user until 20260904140000.
-- The wrapper views (security_invoker = false, tenant filter inside) are the
-- only correct way to read one.
select
  case
    when exists (
      select 1 from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'm'
         and has_table_privilege('authenticated', c.oid, 'SELECT')
    ) then 'BROKEN — a materialized view is granted to authenticated; matviews have no RLS, so that hands every company''s rows to every user'
    when not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = 'demand_coverage_by_type_v'
    ) then 'MISSING — demand_coverage_by_type_v'
    when exists (
      select 1 from pg_views v
       where v.schemaname = 'public' and v.viewname = 'demand_coverage_by_type_v'
         and v.definition ~ '_mv\b'
    ) then 'BROKEN — demand_coverage_by_type_v reads a matview directly; it will raise 42501 for every authenticated user (use the _v wrappers)'
    -- json, not jsonb. jsonb sorts object keys by (length, bytewise), which
    -- silently reorders the columns of EVERY table visual in /v3/. The
    -- renderer cannot recover the select-list order once jsonb has eaten it.
    when not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'chat_run_readonly_query'
         and pg_get_function_result(p.oid) = 'json'
    ) then 'BROKEN — chat_run_readonly_query does not return json; jsonb reorders result columns and every table tile renders its columns wrong'
    -- is_admin_user() sits in 47 policies across 31 tables. As SECURITY
    -- INVOKER every call re-evaluates profiles'' own RLS (measured 50x
    -- slower), which is what made seven dashboard tiles time out.
    when not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'is_admin_user' and p.prosecdef
    ) then 'SLOW — is_admin_user() is not SECURITY DEFINER; it re-evaluates profiles RLS on every call, in 47 policies across 31 tables'
    when not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = 'demand_coverage_base_mv' and c.relkind = 'm'
    ) then 'MISSING — demand_coverage_base_mv; the Logistics tiles will re-scan 66k inventory rows each and time out'
    else 'ok'
  end as reports_runnable;

-- ── Every system report ties out ─────────────────────────────────────
-- A `system` report carries SILO's name, sits on everyone's screen, and
-- nobody re-derives it -- so the first wrong number there costs more trust
-- than ten missing features. Three boards shipped in one day and all three
-- needed correcting after the fact, every time because someone looked
-- rather than because a check ran.
--
-- A tie-out is a SECOND, INDEPENDENT path to a number the report publishes.
-- This asserts that every system report has at least one, and that at least
-- one of them is a real reconciliation rather than a structural sanity
-- check -- re-running a report's own SQL and comparing it to itself proves
-- nothing.
--
-- Run `select * from run_report_tieouts()` to see the numbers themselves.
select
  case
    when not exists (select 1 from information_schema.tables
                     where table_schema='public' and table_name='silo_report_tieouts')
      then 'MISSING — silo_report_tieouts; system reports have no second path to their numbers'
    when exists (select 1 from pg_policies
                  where schemaname='public' and tablename='silo_report_tieouts'
                    and cmd in ('INSERT','UPDATE','ALL'))
      then 'BROKEN — silo_report_tieouts has a client write policy; the runner EXECUTEs what is stored there, so it must be migration-only'
    when (select count(*) from public.silo_chat_saved_reports r
           where r.source = 'system'
             and not exists (select 1 from public.silo_report_tieouts o
                              where o.report_id = r.id and o.enabled)) > 0
      then 'MISSING — ' || (select count(*)::text from public.silo_chat_saved_reports r
                             where r.source = 'system'
                               and not exists (select 1 from public.silo_report_tieouts o
                                                where o.report_id = r.id and o.enabled))
           || ' system report(s) have no tie-out: '
           || (select string_agg(r.title, '; ') from public.silo_chat_saved_reports r
                where r.source = 'system'
                  and not exists (select 1 from public.silo_report_tieouts o
                                   where o.report_id = r.id and o.enabled))
    when (select count(*) from public.silo_chat_saved_reports r
           where r.source = 'system'
             and not exists (select 1 from public.silo_report_tieouts o
                              where o.report_id = r.id and o.enabled
                                and o.kind = 'reconciliation')) > 0
      then 'WEAK — ' || (select string_agg(r.title, '; ') from public.silo_chat_saved_reports r
                          where r.source = 'system'
                            and not exists (select 1 from public.silo_report_tieouts o
                                             where o.report_id = r.id and o.enabled
                                               and o.kind = 'reconciliation'))
           || ' have only sanity checks, no independent reconciliation'
    else 'ok'
  end as system_reports_tie_out;

-- Canned report accuracy definitions (fixture-tested).
with expected(id) as (select unnest(array['5110de50-0000-4000-a000-000000000001','5110de50-0000-4000-a000-000000000002','5110de50-0000-4000-a000-000000000003','c3000000-0000-4000-a000-000000000001','c3000000-0000-4000-a000-000000000002','c3000000-0000-4000-a000-000000000003','c3000000-0000-4000-a000-000000000004','c3000000-0000-4000-a000-000000000005','c3000000-0000-4000-a000-000000000006','c1000000-0000-4000-a000-000000000001','c1000000-0000-4000-a000-000000000005','c1000000-0000-4000-a000-000000000006','c1000000-0000-4000-a000-000000000007','c1000000-0000-4000-a000-000000000008','c1000000-0000-4000-a000-000000000009','c1000000-0000-4000-a000-00000000000a']::uuid[]))
select case
 when exists (select 1 from expected e left join public.silo_chat_saved_reports r on r.id=e.id
              where r.id is null or r.source <> 'system' or r.company_entity_id is not null)
 then 'MISSING — shared canned report definitions'
 when exists (select 1 from expected e join public.silo_chat_saved_reports r on r.id=e.id
              where r.parameters is null or exists (
                select 1 from jsonb_array_elements(r.parameters) p
                where p->>'type'='date' and (p->>'date_basis' is distinct from 'company' or p->>'default' !~ '^today-[0-9]+d$')))
 then 'STALE — canned report defaults must follow the company calendar'
 when exists (select 1 from expected e where not exists (
              select 1 from public.silo_report_tieouts t where t.report_id=e.id and t.enabled
              and t.kind='reconciliation' and t.tolerance<=0.01 and t.check_sql like '%md5(queries_run::text || parameters::text)%'))
 then 'WEAK — canned reports need strict checks tied to their deployed definitions'
 else 'ok' end as canned_report_accuracy;
-- End canned report accuracy definitions.

select
  case
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='silo_chat_saved_reports'
                       and column_name='source')
      then 'MISSING — run 20260828130000_saved_report_source.sql'
    when not exists (select 1 from pg_constraint
                     where conrelid='public.silo_chat_saved_reports'::regclass
                       and conname='silo_chat_saved_reports_global_is_system_check')
      then 'MISSING — the global-is-system CHECK; without it a null-company row need not be source=system, and the SELECT policy would show one user''s report to every company'
    when not exists (select 1 from pg_policies
                     where schemaname='public' and tablename='silo_chat_saved_reports'
                       and policyname='silo_chat_saved_reports_insert'
                       and with_check like '%company_entity_id IS NOT NULL%')
      then 'MISSING — insert policy lost its explicit company_entity_id IS NOT NULL guard. Not immediately exploitable (NULL = active_company_id() is NULL, which RLS already treats as failure) but the protection is then emergent from three-valued logic rather than stated, and any NULL-tolerant rewrite of that comparison silently removes it'
    when not exists (select 1 from pg_policies
                     where schemaname='public' and tablename='silo_chat_saved_reports'
                       and policyname='silo_chat_saved_reports_insert'
                       and with_check like '%ask_silo%')
      then 'MISSING — insert policy no longer restricts source; a client could create a system report'
    when not exists (select 1 from pg_policies
                     where schemaname='public' and tablename='silo_chat_saved_reports'
                       and policyname='silo_chat_saved_reports_update'
                       and with_check like '%ask_silo%')
      then 'MISSING — update policy no longer restricts source; a user could promote their own report to a global system definition'
    when not exists (select 1 from pg_policies
                     where schemaname='public' and tablename='silo_chat_saved_reports'
                       and policyname='silo_chat_saved_reports_select'
                       and qual like '%source = ''system''%')
      then 'MISSING — select policy lost the global system branch; central SILO report definitions are invisible to everyone'
    when exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='silo_chat_saved_reports'
                   and column_name in ('question','answer') and is_nullable='NO')
      then 'MISSING — question/answer are still NOT NULL; a system report was never a conversation and cannot be seeded'
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='dashboard_widgets_v'
                       and column_name='report_source')
      then 'MISSING — dashboard_widgets_v.report_source'
    else 'ok'
  end as saved_report_source;

select
  case
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='silo_chat_saved_reports'
                       and column_name='columns_metadata')
      then 'MISSING — run 20260828140000_saved_report_column_semantics.sql'
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='dashboard_widgets_v'
                       and column_name='report_columns_metadata')
      then 'MISSING — dashboard_widgets_v.report_columns_metadata; dashboards fall back to guessing currency vs count from column names'
    else 'ok'
  end as saved_report_column_semantics;

select
  case
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='silo_chat_saved_reports'
                       and column_name='parameters')
      then 'MISSING — run 20260903100000_report_parameters.sql'
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='dashboards'
                       and column_name='filter_state')
      then 'MISSING — dashboards.filter_state; a dashboard cannot remember where its slicers were set'
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='dashboard_widgets_v'
                       and column_name='report_parameters')
      then 'MISSING — dashboard_widgets_v.report_parameters; every parameterised tile renders "not a declared parameter" because the renderer cannot see the declarations'
    when not exists (select 1 from pg_constraint
                     where conrelid='public.silo_chat_saved_reports'::regclass
                       and conname='silo_chat_saved_reports_parameters_is_array')
      then 'MISSING — the parameters-is-array CHECK; a non-array normalises to zero declarations, so every {{token}} in that report becomes undeclared and the report stops running'
    when not exists (select 1 from pg_constraint
                     where conrelid='public.dashboards'::regclass
                       and conname='dashboards_filter_state_is_object')
      then 'MISSING — the filter_state-is-object CHECK'
    -- A report whose SQL carries a {{token}} it does not declare cannot run
    -- at all: substitution refuses it by design, since the declaration IS
    -- the allowlist. Cheap to check here, and the failure is otherwise only
    -- visible as a broken tile.
    when exists (
      select 1 from public.silo_chat_saved_reports r,
                    unnest(coalesce(r.queries_run, array[]::text[])) as q
       where q ~ '\{\{[a-zA-Z]'
         and exists (
           select 1 from regexp_matches(q, '\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}', 'g') as m
            where not exists (
              select 1 from jsonb_array_elements(coalesce(r.parameters, '[]'::jsonb)) as d
               where lower(d ->> 'key') = lower(m[1]))))
      then 'BROKEN — a saved report uses a {{token}} its parameters do not declare; that report cannot run at all (an undeclared token is refused, not passed through). Fix the report''s parameters or remove the token'
    else 'ok'
  end as report_parameters;

select
  case
    when (select count(*) from public.silo_chat_saved_reports
           where source = 'system'
             and id in ('5110de50-0000-4000-a000-000000000001',
                        '5110de50-0000-4000-a000-000000000002',
                        '5110de50-0000-4000-a000-000000000003',
                        '5110de50-0000-4000-a000-000000000004')) < 4
      then 'MISSING — run 20260828150000_seed_system_reports.sql; dashboards have nothing to build on unless someone has saved an Ask SILO report'
    when exists (select 1 from public.silo_chat_saved_reports
                  where source = 'system' and company_entity_id is not null)
      then 'MISSING — a system report is scoped to one company; system definitions are meant to be global (company_entity_id IS NULL) and reused by every tenant'
    when exists (select 1 from public.silo_chat_saved_reports
                  where source = 'system' and coalesce(array_length(queries_run, 1), 0) = 0)
      then 'MISSING — a system report has no SQL to run'
    when not exists (select 1 from public.silo_chat_saved_reports
                      where id = '5110de50-0000-4000-a000-000000000002'
                        and queries_run[1] like '%x-redo%')
      then 'MISSING — Top Products no longer excludes x-redo; Redo''s Package Protection line item is not merchandise and outranks every real product (8,209 units when this was found). See 20260902100000_fix_top_products_redo_filter.sql'
    else 'ok'
  end as seed_system_reports;

select
  case
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='silo_chat_schema_catalog'
                       and column_name='reportable')
      then 'MISSING — run 20260902110000_report_builder_reportable.sql'
    when exists (select 1 from public.silo_chat_schema_catalog
                  where reportable
                    and (relname like 'payroll%' or relname like 'ar\_%' or relname like 'comp\_%'
                      or relname like 'payment\_request%' or relname like 'journal%'
                      or relname like 'quickbooks%' or relname like 'review%'
                      or relname like 'employee%' or relname like 'silo\_chat%'
                      or relname like 'fixed\_asset%' or relname like 'card\_%'
                      or relname like 'accounting\_%' or relname like 'schedule\_%'
                      or relname like 'credit\_facilit%' or relname like 'cash\_forecast%'))
      then 'MISSING — a finance or HR object is offered in the report builder rail; the workbench is for commercial reporting only (RLS is still the boundary, but it should not be OFFERED)'
    when (select count(*) from public.silo_chat_schema_catalog where reportable) = 0
      then 'MISSING — nothing is marked reportable; the report builder rail will be empty'
    else 'ok'
  end as report_builder_reportable;

select
  case
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='silo_chat_schema_catalog'
                       and column_name='report_priority')
      then 'MISSING — run 20260902120000_report_builder_start_here.sql'
    when (select count(*) from public.silo_chat_schema_catalog where report_priority = 1) = 0
      then 'MISSING — nothing is marked "Start here"; the report builder rail opens on an undifferentiated alphabetical list'
    when exists (select 1 from public.silo_chat_schema_catalog where report_priority = 1 and not reportable)
      then 'MISSING — an object is starred but not reportable, so it is promoted into a rail it never appears in'
    else 'ok'
  end as report_builder_start_here;

-- ---------------------------------------------------------------------------
-- Cash flow forecast (20260904310000_cash_flow_forecast.sql)
-- ---------------------------------------------------------------------------
select
  case
    when not exists (select 1 from information_schema.tables
                      where table_schema='public' and table_name='credit_facilities')
      then 'MISSING — credit_facilities absent; run 20260904310000_cash_flow_forecast.sql'
    when not exists (select 1 from information_schema.tables
                      where table_schema='public' and table_name='cash_forecast_items')
      then 'MISSING — cash_forecast_items absent'
    when not exists (select 1 from information_schema.check_constraints
                      where constraint_schema = 'public'
                        and constraint_name = 'cash_forecast_items_cadence_matches_kind')
      then 'MISSING — the kind/cadence CHECK is absent; a recurring item could be saved with no '
        || 'cadence (never generates an occurrence) or a one-time item with one (never used, but '
        || 'confusing on the register)'
    else 'ok'
  end as cash_flow_forecast;

-- ---------------------------------------------------------------------------
-- Retired Better Reports inventory archive
-- (20260908120000_drop_retired_better_reports_inventory.sql)
--
-- inventory_on_hand should hold ONLY the current snapshot. The Shopify sync
-- purges and replaces on every run, so anything from a retired source is an
-- archive nothing reads -- it was 3,400,748 rows and ~4.9 GB before it was
-- removed. A non-zero count here means either the migration has not run or a
-- retired pipeline has started writing again.
-- ---------------------------------------------------------------------------
select
  case
    when (select count(*) from public.inventory_on_hand
           where source = 'better_reports') > 0
      then 'MISSING — better_reports rows still present ('
        || (select to_char(count(*),'FM999,999,999') from public.inventory_on_hand
             where source = 'better_reports')
        || ' rows); run 20260908120000_drop_retired_better_reports_inventory.sql'
    when exists (select 1 from pg_indexes
                  where schemaname='public' and tablename='inventory_on_hand'
                    and indexname in ('inventory_on_hand_loc_sku_batch_idx',
                                      'inventory_on_hand_batch_idx'))
      then 'MISSING — the two unused sync_batch_id indexes are back; nothing '
        || 'queries sync_batch_id and every sync run pays to maintain them'
    else 'ok'
  end as inventory_archive_removed;



-- ---------------------------------------------------------------------------
-- Ask SILO catalog: the evidence caveats (20260908150000) are still present.
--
-- These are the schema-side half of the 2026-09-08 evidence-discipline fix;
-- the other half is in the silo-chat edge function's prompt. They matter
-- because a caveat only covers the failure it names: the previous
-- landing-pages description warned against SUMMING the table, and that
-- warning held -- the answer that went wrong did not sum it. It concluded
-- eight collections "don't exist" from a top-N slice instead, which nothing
-- warned about. Descriptions survive refresh_chat_schema_catalog() by
-- design, so a failure here means the migration has not run or something
-- overwrote a description by hand.
-- ---------------------------------------------------------------------------
select
  case
    when not exists (select 1 from public.silo_chat_schema_catalog
                      where relname = 'shopify_landing_pages_daily'
                        and description like '%ABSENCE IS NOT NONEXISTENCE%')
      then 'MISSING — shopify_landing_pages_daily lost its absence-is-not-'
        || 'nonexistence caveat; run 20260908150000_chat_catalog_evidence_caveats.sql'
    when not exists (select 1 from public.silo_chat_schema_catalog
                      where relname = 'marketing_kpis_daily'
                        and description like '%GRAIN IS OURS, NOT THE PROVIDER%')
      then 'MISSING — marketing_kpis_daily lost the our-grain-vs-provider-'
        || 'capability caveat; run 20260908150000_chat_catalog_evidence_caveats.sql'
    when not exists (select 1 from public.silo_chat_schema_catalog
                      where relname = 'sales_by_product_title_daily_v'
                        and description like '%RANKS SALES, NOT AVAILABILITY%')
      then 'MISSING — sales_by_product_title_daily_v lost the availability '
        || 'caveat; run 20260908150000_chat_catalog_evidence_caveats.sql'
    else 'ok'
  end as silo_chat_catalog_evidence_caveats;


-- ---------------------------------------------------------------------------
-- Shopify collections registry (20260909120000): the three tables exist, and
-- the two columns whose NULL semantics are load-bearing are still documented
-- in the Ask SILO catalog.
--
-- published_to_online_store is tri-state (null = UNKNOWN, not "no") and the
-- seo_*_override columns hold overrides only (null = inherits, not
-- "missing SEO"). Both are the kind of fact a reader infers wrongly by
-- default, so if the catalog description loses them the table starts
-- producing confident false findings -- which is the exact failure this
-- registry was built to end.
-- ---------------------------------------------------------------------------
select
  case
    when (select count(*) from information_schema.tables
           where table_schema = 'public'
             and table_name in ('shopify_collections',
                                'shopify_collection_products',
                                'shopify_collection_sync_runs')) < 3
      then 'MISSING — run 20260909120000_shopify_collections_registry.sql'
    when not exists (select 1 from information_schema.columns
                      where table_schema='public' and table_name='products_master'
                        and column_name = 'shopify_product_id')
      then 'MISSING — products_master.shopify_product_id absent; collection '
        || 'membership cannot join to products'
    when not exists (select 1 from public.silo_chat_schema_catalog
                      where relname = 'shopify_collections'
                        and description like '%TRI-STATE%')
      then 'MISSING — shopify_collections lost the tri-state '
        || 'published_to_online_store note; null will be read as "not published"'
    when not exists (select 1 from public.silo_chat_schema_catalog
                      where relname = 'shopify_collections'
                        and description like '%OVERRIDES ONLY%')
      then 'MISSING — shopify_collections lost the seo override note; '
        || 'un-customised collections will be reported as missing SEO'
    -- Once the sync shipped (20260909160000) the description had to stop
    -- saying NOT POPULATED YET and start saying how to CHECK -- a registry
    -- is authoritative only for a shop whose latest run finished, and only
    -- as of when it finished. Losing this sentence returns the table to
    -- being read as unconditionally complete.
    when not exists (select 1 from public.silo_chat_schema_catalog
                      where relname = 'shopify_collections'
                        and description like '%completed_at set%')
      then 'MISSING — shopify_collections no longer tells the model to '
        || 'require a completed sync run before claiming a collection is gone'
    when exists (select 1 from public.silo_chat_schema_catalog
                  where relname = 'shopify_collections'
                    and description like '%NOT POPULATED YET%')
      then 'STALE — shopify_collections still says NOT POPULATED YET, but '
        || 'the collections sync has shipped; run 20260909160000'
    -- The migration seeds these rows with columns = '[]' and then calls
    -- refresh_chat_schema_catalog() to fill them from pg_catalog. If that
    -- call is ever dropped, Ask SILO sees three tables it can name and
    -- describe but whose COLUMNS it does not know, and writes queries
    -- against guessed column names -- the exact failure the catalog exists
    -- to prevent. Caught in review of PR #633, where the refresh had been
    -- run by hand in prod and was missing from the migration, so a rebuild
    -- from apply_all_post_merge.sql would not have reproduced it.
    when exists (select 1 from public.silo_chat_schema_catalog
                  where relname in ('shopify_collections',
                                    'shopify_collection_products',
                                    'shopify_collection_sync_runs')
                    and jsonb_array_length(coalesce(columns, '[]'::jsonb)) = 0)
      then 'MISSING — a collections-registry catalog entry has no columns; '
        || 'run select public.refresh_chat_schema_catalog()'
    else 'ok'
  end as shopify_collections_registry;

-- ── Search Console connection (20260909180000) ──────────────────────────────
-- The whole reason the migration exists: ad_platform_connections' platform
-- CHECK is what stopped the finished Google OAuth plumbing from being reused
-- for Search Console. If either CHECK loses the value, connecting silently
-- fails at the callback's insert with a constraint error and no OAuth error
-- to point at.
select
  case
    when not exists (select 1 from pg_constraint
                     where conname = 'ad_platform_connections_platform_check'
                       and pg_get_constraintdef(oid) like '%search_console%')
      then 'MISSING — ad_platform_connections rejects platform=search_console'
    when not exists (select 1 from pg_constraint
                     where conname = 'ad_platform_oauth_states_platform_check'
                       and pg_get_constraintdef(oid) like '%search_console%')
      then 'MISSING — ad_platform_oauth_states rejects platform=search_console, '
        || 'so google-oauth-start cannot mint a CSRF nonce for it'
    -- Dropping one of the OTHER values while extending the list is the real
    -- risk here, since the constraint is re-typed rather than appended to,
    -- and an existing row would keep working until the next write.
    when not exists (select 1 from pg_constraint
                     where conname = 'ad_platform_connections_platform_check'
                       and pg_get_constraintdef(oid) like '%google_ads%'
                       and pg_get_constraintdef(oid) like '%meta_ads%'
                       and pg_get_constraintdef(oid) like '%tiktok_ads%'
                       and pg_get_constraintdef(oid) like '%ga4%')
      then 'MISSING — extending the platform CHECK dropped an existing platform'
    when not exists (select 1 from information_schema.columns
                     where table_schema = 'public'
                       and table_name = 'ad_platform_connections'
                       and column_name = 'search_console_site_url')
      then 'MISSING — ad_platform_connections.search_console_site_url'
    else 'ok'
  end as search_console_connection;

-- ── Search Console daily tables (20260910180000) ────────────────────────────
-- Three grains, three tables, and the site table carrying the per-day
-- attribution the probe measured (query cut recovers 56.9% of clicks). The
-- checks are about what makes the tables HONEST, not merely present: the
-- generated unattributed columns, service-role-only writes, the job_type
-- value the nightly inserts, and the catalog caveats the model reads.
select
  case
    when (select count(*) from information_schema.tables
          where table_schema = 'public'
            and table_name in ('search_console_site_daily', 'search_console_page_daily', 'search_console_query_daily')) < 3
      then 'MISSING — run 20260910180000_search_console_daily.sql'
    when (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relrowsecurity
            and c.relname in ('search_console_site_daily', 'search_console_page_daily', 'search_console_query_daily')) < 3
      then 'CRITICAL — a search_console_* table has RLS disabled'
    when exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename like 'search\_console\_%\_daily'
                   and cmd <> 'SELECT')
      then 'CRITICAL — a search_console_* table has a client write policy; writes are the sync''s alone'
    when not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'search_console_site_daily'
                       and column_name = 'unattributed_query_click_share'
                       and is_generated = 'ALWAYS')
      then 'MISSING — search_console_site_daily.unattributed_query_click_share is not a generated column'
    when not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'search_console_page_daily'
                       and column_name = 'page_path' and is_generated = 'ALWAYS')
      then 'MISSING — search_console_page_daily.page_path is not a generated column'
    when not exists (select 1 from pg_constraint
                     where conname = 'sync_jobs_job_type_check'
                       and pg_get_constraintdef(oid) like '%search_console_daily%')
      then 'MISSING — sync_jobs rejects job_type=search_console_daily; the nightly cannot record a run'
    -- The constraint is rewritten from its live definition; if that ever
    -- regresses to a retyped list, an older value goes missing first.
    when not exists (select 1 from pg_constraint
                     where conname = 'sync_jobs_job_type_check'
                       and pg_get_constraintdef(oid) like '%collections_sync%'
                       and pg_get_constraintdef(oid) like '%landing_pages_sync%'
                       and pg_get_constraintdef(oid) like '%ga4_kpis%')
      then 'MISSING — extending sync_jobs_job_type_check dropped an existing value'
    when (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
          where t.tgname = 'stamp_company_entity_id' and not t.tgisinternal
            and c.relname in ('search_console_site_daily', 'search_console_page_daily', 'search_console_query_daily')) < 3
      then 'MISSING — a search_console_* table has no stamp_company_entity_id trigger; run attach_stamp_company_entity_id_triggers()'
    when not exists (select 1 from public.silo_chat_schema_catalog
                     where relname = 'search_console_site_daily'
                       and description like '%QUERY ATTRIBUTION IS PARTIAL%')
      then 'MISSING — search_console_site_daily lost its partial-attribution caveat'
    when not exists (select 1 from public.silo_chat_schema_catalog
                     where relname = 'search_console_query_daily'
                       and description like '%DELIBERATELY INCOMPLETE%')
      then 'MISSING — search_console_query_daily lost its deliberately-incomplete caveat'
    -- 20260910180000 shipped the PAGE row saying a missing page row "genuinely
    -- had no search clicks". Google does not guarantee every row is returned,
    -- so that sentence teaches the exact negative-claim-from-a-partial-list
    -- error this project exists to prevent. 20260910190000 replaces it; this
    -- fails if the wrong sentence is ever back or the correction is absent.
    when exists (select 1 from public.silo_chat_schema_catalog
                 where relname in ('search_console_page_daily', 'search_console_site_daily')
                   and (description like '%genuinely had no search clicks%'
                        or description like '%Page attribution is complete on clicks%'))
      then 'CRITICAL — a search_console_* catalog row again claims page absence means zero clicks; run 20260910190000_search_console_page_absence_caveat.sql'
    when not exists (select 1 from public.silo_chat_schema_catalog
                     where relname = 'search_console_page_daily'
                       and description like '%ABSENCE IS NOT ZERO%')
      then 'MISSING — search_console_page_daily lacks its absence-is-not-zero caveat; run 20260910190000_search_console_page_absence_caveat.sql'
    -- Preserve uncertainty about repeated row counts.
    when (select count(*) from public.silo_chat_schema_catalog
          where relname in ('search_console_query_daily', 'search_console_site_daily')
            and description like '%QUERY ROW OBSERVATION%') < 2
      then 'MISSING — search_console query/site rows lack the query row observation caveat; run 20260910200000_search_console_query_cap_caveat.sql'
    when exists (select 1 from public.silo_chat_schema_catalog
                 where relname in ('search_console_query_daily', 'search_console_site_daily')
                   and description like '%PER-DAY ROW CAP:%')
      then 'CRITICAL — unsupported 5,000-row cap claim has returned'
    -- /v2/seo-overview.html reads through three RPCs (20260910210000). They
    -- must exist, be callable by authenticated, and NOT by anon -- Supabase's
    -- default privileges re-grant EXECUTE on new public functions to anon.
    when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname in ('search_console_overview', 'search_console_top_pages', 'search_console_top_queries')) < 3
      then 'MISSING — an SEO overview RPC is absent; run 20260910210000_search_console_overview_rpcs.sql'
    when has_function_privilege('anon', 'public.search_console_overview(integer, date)', 'execute')
      or has_function_privilege('anon', 'public.search_console_top_pages(integer, date, integer)', 'execute')
      or has_function_privilege('anon', 'public.search_console_top_queries(integer, date, integer)', 'execute')
      then 'CRITICAL — anon can execute an SEO overview RPC; revoke it (20260910210000 does)'
    when not has_function_privilege('authenticated', 'public.search_console_overview(integer, date)', 'execute')
      then 'MISSING — authenticated cannot execute search_console_overview; the SEO overview page cannot load'
    when exists (select 1 from public.silo_chat_schema_catalog
                 where relname like 'search\_console\_%\_daily'
                   and jsonb_array_length(coalesce(columns, '[]'::jsonb)) = 0)
      then 'MISSING — a search_console_* catalog entry has no columns; run select public.refresh_chat_schema_catalog()'
    else 'ok'
  end as search_console_daily_tables;

-- ── Search Console: the newest completed run wins (20260914130000) ──────────
-- The nightly and the manual backfill overlap with no concurrency gate. The
-- retirement sweep is ordered by synced_at in the sync core, but a plain
-- upsert from an OLDER run resuming after a newer one completed would still
-- rewrite shared identities and the site totals with the older payload. One
-- BEFORE trigger on all three tables refuses that: an update older than the
-- stored row, or a detail insert for a day whose site row a newer run has
-- already written. Without it "overlap is safe" (backfill.yml) is false.
select
  case
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public' and p.proname = 'search_console_reject_stale_write')
      then 'MISSING — run 20260914130000_search_console_newest_run_wins.sql'
    when (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
          where t.tgname = 'trg_search_console_newest_run_wins' and not t.tgisinternal
            and c.relname in ('search_console_site_daily', 'search_console_page_daily', 'search_console_query_daily')) < 3
      then 'CRITICAL — trg_search_console_newest_run_wins is not on all three search_console_*_daily tables; '
        || 'an older overlapping run can overwrite a newer completed one'
    -- Both halves of the rule must survive an edit: the update guard and the
    -- site-row-newer insert guard.
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public' and p.proname = 'search_console_reject_stale_write'
                       and pg_get_functiondef(p.oid) ~ 'new\.synced_at[[:space:]]*<[[:space:]]*old\.synced_at'
                       and pg_get_functiondef(p.oid) ~ 's\.synced_at[[:space:]]*>[[:space:]]*new\.synced_at')
      then 'CRITICAL — search_console_reject_stale_write() lost one half of the newest-run-wins rule'
    else 'ok'
  end as search_console_newest_run_wins;

-- ── Per-shop product/SKU mapping (20260909200000) ───────────────────────────
-- products_master is one row per (company, sku), so its shopify_product_id is
-- whichever store synced last -- measured 2026-09-09: 26.9% of sold SKUs exist
-- in more than one shop, and 43% of stamped rows are contested. This table is
-- what makes collection membership joinable to sales/inventory at all, so the
-- checks below are about the properties that make it CORRECT, not merely
-- present.
select
  case
    when not exists (select 1 from information_schema.tables
                     where table_schema='public' and table_name='shopify_product_skus')
      then 'MISSING — shopify_product_skus'
    -- Identity must be the VARIANT. A unique index on (company, shop, sku)
    -- would silently re-introduce the collapse this table exists to undo.
    when not exists (select 1 from pg_indexes
                     where schemaname='public' and indexname='shopify_product_skus_identity')
      then 'MISSING — shopify_product_skus_identity unique index (company, shop_domain, shopify_variant_id)'
    when not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
                     where n.nspname='public' and c.relname='shopify_product_skus' and c.relrowsecurity)
      then 'MISSING — RLS not enabled on shopify_product_skus'
    when not exists (select 1 from pg_policies
                     where schemaname='public' and tablename='shopify_product_skus'
                       and qual like '%active_company_id%')
      then 'MISSING — shopify_product_skus select policy is not company-scoped'
    when exists (select 1 from pg_policies
                 where schemaname='public' and tablename='shopify_product_skus'
                   and cmd in ('INSERT','UPDATE','DELETE','ALL'))
      then 'UNEXPECTED — shopify_product_skus has a client write policy; it is sync-owned'
    when not exists (select 1 from information_schema.views
                     where table_schema='public' and table_name='shopify_collection_skus_v')
      then 'MISSING — shopify_collection_skus_v'
    -- sku_unresolved is the honesty column: without it a caller cannot tell
    -- "this collection has no more products" from "we have not mapped them
    -- yet", and a create-or-replace that drops it does not error.
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='shopify_collection_skus_v'
                       and column_name='sku_unresolved')
      then 'MISSING — shopify_collection_skus_v lost sku_unresolved; unmapped products become indistinguishable from absent ones'
    when not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
                     where n.nspname='public' and c.relname='shopify_collection_skus_v'
                       and 'security_invoker=true' = any(c.reloptions))
      then 'MISSING — shopify_collection_skus_v is not security_invoker'
    when exists (select 1 from public.silo_chat_schema_catalog
                 where relname in ('shopify_product_skus','shopify_collection_skus_v')
                   and jsonb_array_length(coalesce(columns,'[]'::jsonb)) = 0)
      then 'MISSING — a product-SKU catalog entry has no columns; run select public.refresh_chat_schema_catalog()'
    -- The table looks like a registry and is not one. Losing this sentence
    -- invites exactly the absence-means-nonexistence claim the collections
    -- work was built to stop.
    when not exists (select 1 from public.silo_chat_schema_catalog
                     where relname='shopify_product_skus' and description like '%NOT A REGISTRY%')
      then 'MISSING — shopify_product_skus catalog entry no longer says it is not a registry'
    else 'ok'
  end as shopify_product_sku_mapping;

-- ── Page inspection (20260909220000) ────────────────────────────────────────
-- shopify_shop_domains IS a security boundary: a row in it authorises an
-- outbound fetch from our infrastructure. The checks that matter are that it
-- stays sync-owned and company-scoped, not merely that it exists.
select
  case
    when not exists (select 1 from information_schema.tables
                     where table_schema='public' and table_name='shopify_shop_domains')
      then 'MISSING — shopify_shop_domains'
    when exists (select 1 from pg_policies
                 where schemaname='public' and tablename='shopify_shop_domains'
                   and cmd in ('INSERT','UPDATE','DELETE','ALL'))
      then 'CRITICAL — shopify_shop_domains has a client write policy; a row here '
        || 'authorises page-inspect to fetch that host'
    when not exists (select 1 from pg_policies
                     where schemaname='public' and tablename='shopify_shop_domains'
                       and qual like '%active_company_id%')
      then 'MISSING — shopify_shop_domains select policy is not company-scoped'
    when not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
                     where n.nspname='public' and c.relname='shopify_shop_domains' and c.relrowsecurity)
      then 'MISSING — RLS not enabled on shopify_shop_domains'
    when not exists (select 1 from pg_indexes
                     where schemaname='public' and indexname='shopify_shop_domains_identity')
      then 'MISSING — shopify_shop_domains_identity unique index (company, host)'
    when not exists (select 1 from information_schema.tables
                     where table_schema='public' and table_name='page_inspections')
      then 'MISSING — page_inspections'
    when exists (select 1 from pg_policies
                 where schemaname='public' and tablename='page_inspections'
                   and cmd in ('INSERT','UPDATE','DELETE','ALL'))
      then 'UNEXPECTED — page_inspections has a client write policy; a hand-written '
        || 'row would look like a capture that never happened'
    -- Completeness columns. A capture without them cannot be compared to
    -- another capture honestly, which is the only reason to store one.
    when (select count(*) from information_schema.columns
          where table_schema='public' and table_name='page_inspections'
            and column_name in ('fetched_at','is_truncated','fetch_error','redirect_chain')) <> 4
      then 'MISSING — page_inspections lost a completeness column '
        || '(fetched_at / is_truncated / fetch_error / redirect_chain)'
    -- The catalog entry must keep saying this is not search data, or the model
    -- will be invited to read meta_robots as an indexing observation.
    when not exists (select 1 from public.silo_chat_schema_catalog
                     where relname='page_inspections'
                       and description like '%no Search Console or search-engine data%')
      then 'MISSING — page_inspections catalog entry no longer disclaims search data'
    when exists (select 1 from public.silo_chat_schema_catalog
                 where relname in ('page_inspections','shopify_shop_domains')
                   and jsonb_array_length(coalesce(columns,'[]'::jsonb)) = 0)
      then 'MISSING — a page-inspection catalog entry has no columns; run select public.refresh_chat_schema_catalog()'
    else 'ok'
  end as page_inspection;

-- ── SEO project workflow (20260909240000) ───────────────────────────────────
-- The two invariants are STRUCTURAL, so they are checked structurally here.
-- Behaviour (triggers, constraints, what the view derives) is exercised
-- against a real database by scripts/sql/verify_seo_workflow.sql.
select
  case
    when (select count(*) from information_schema.tables
          where table_schema='public'
            and table_name in ('seo_projects','seo_tasks','seo_task_revisions',
                               'seo_task_publications','seo_measurements','seo_approvers')) <> 6
      then 'MISSING — an SEO workflow table'
    -- INVARIANT 1, enforced by ABSENCE. If a publication/published/live column
    -- ever appears on seo_tasks, approval can advance it and the guarantee is
    -- gone -- publication must stay the existence of an evidence row.
    when exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='seo_tasks'
                   and (column_name like '%publish%' or column_name = 'is_live'))
      then 'CRITICAL — seo_tasks grew a publication column; approval can now mark '
        || 'something live without evidence. Publication belongs in seo_task_publications'
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='can_approve_seo_tasks')
      then 'MISSING — can_approve_seo_tasks()'
    -- It must not quietly widen to every membership admin: 28 of 29 profiles
    -- here carry that role.
    when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                 where n.nspname='public' and p.proname='can_approve_seo_tasks'
                   and pg_get_functiondef(p.oid) like '%is_admin_user%')
      then 'CRITICAL — can_approve_seo_tasks() now calls is_admin_user(), which passes '
        || 'for nearly every profile in this company'
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='can_approve_seo_tasks'
                       and pg_get_functiondef(p.oid) like '%active_company_id%')
      then 'CRITICAL — can_approve_seo_tasks() no longer scopes the grant to the '
        || 'active company; an approver at one tenant could approve at another'
    -- Approval enforcement lives in the UPDATE policy's WITH CHECK.
    when not exists (select 1 from pg_policies
                     where schemaname='public' and tablename='seo_tasks'
                       and policyname='seo_tasks_update'
                       and with_check like '%can_approve_seo_tasks%')
      then 'CRITICAL — seo_tasks_update no longer gates the approved state server-side'
    when not exists (select 1 from pg_policies
                     where schemaname='public' and tablename='seo_tasks'
                       and policyname='seo_tasks_insert'
                       and with_check like '%can_approve_seo_tasks%')
      then 'CRITICAL — a task can be INSERTED already approved'
    -- Revisions are trigger-written history; a client write policy would let
    -- someone rewrite what a page was asked to say.
    when exists (select 1 from pg_policies
                 where schemaname='public' and tablename='seo_task_revisions'
                   and cmd in ('INSERT','UPDATE','DELETE','ALL'))
      then 'CRITICAL — seo_task_revisions has a client write policy; history is rewritable'
    when not exists (select 1 from pg_trigger
                     where tgname='trg_record_seo_task_revision' and not tgisinternal)
      then 'MISSING — trg_record_seo_task_revision'
    when not exists (select 1 from pg_trigger
                     where tgname in ('trg_seo_measurement_window', 'trg_seo_baseline_precedes_publication') and not tgisinternal)
      then 'MISSING — trg_seo_measurement_window (invariant 2; named trg_seo_baseline_precedes_publication before 20260914120000)'
    when not exists (select 1 from pg_constraint
                     where conname='seo_task_publications_verified_needs_evidence')
      then 'MISSING — a verified_capture publication can be recorded with no evidence'
    -- The measurement columns that make a number comparable to another number.
    when (select count(*) from information_schema.columns
          where table_schema='public' and table_name='seo_measurements'
            and column_name in ('source','period_start','period_end','captured_at',
                                'dimensions','filters','is_complete','window_kind')) <> 8
      then 'MISSING — seo_measurements lost a provenance column'
    -- The grant table is written from a browser (/v2/backend.html), so it needs
    -- the same backstops silo_chat_managers has. Both were absent on every
    -- table created 2026-09-09 (20260910130000).
    when not exists (select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid
                     where c.relname='seo_approvers' and t.tgname='stamp_company_entity_id'
                       and not t.tgisinternal)
      then 'MISSING — seo_approvers has no stamp_company_entity_id trigger; run attach_stamp_company_entity_id_triggers()'
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='seo_approvers'
                       and column_name='granted_by' and column_default like '%auth.uid()%')
      then 'MISSING — seo_approvers.granted_by has no auth.uid() default (20260910130000)'
    when not exists (select 1 from information_schema.views
                     where table_schema='public' and table_name='seo_tasks_v')
      then 'MISSING — seo_tasks_v'
    when not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
                     where n.nspname='public' and c.relname='seo_tasks_v'
                       and 'security_invoker=true' = any(c.reloptions))
      then 'MISSING — seo_tasks_v is not security_invoker'
    -- The catalog must keep telling the model both rules, or it will read a
    -- delta as a result and an approval as a launch.
    when not exists (select 1 from public.silo_chat_schema_catalog
                     where relname='seo_measurements'
                       and description like '%not proof that the change caused it%')
      then 'MISSING — seo_measurements catalog entry lost the causation caveat'
    when not exists (select 1 from public.silo_chat_schema_catalog
                     where relname='seo_tasks'
                       and description like '%NO PUBLICATION COLUMN%')
      then 'MISSING — seo_tasks catalog entry no longer says approval is not publication'
    when exists (select 1 from public.silo_chat_schema_catalog
                 where relname like 'seo\_%'
                   and jsonb_array_length(coalesce(columns,'[]'::jsonb)) = 0)
      then 'MISSING — an SEO catalog entry has no columns; run select public.refresh_chat_schema_catalog()'
    else 'ok'
  end as seo_project_workflow;

-- ── SEO workflow integrity (20260909260000, corrective) ─────────────────────
-- Each check here corresponds to a gap review found in 20260909220000 /
-- 20260909240000. They are separate from the block above because losing one of
-- these does not remove a table -- it silently removes a guarantee.
select
  case
    -- Tenant identity tied to the PARENT ROW. A single-column FK lets a child
    -- carry company A while citing company B's parent, and every downstream
    -- join uses the child's own company id, so the row looks native.
    when (select count(*) from pg_constraint
          where conname in ('seo_tasks_project_company_fkey',
                            'seo_task_revisions_task_company_fkey',
                            'seo_task_publications_task_company_fkey',
                            'seo_task_publications_inspection_company_fkey',
                            'seo_measurements_project_company_fkey',
                            'seo_measurements_task_company_fkey',
                            'seo_measurements_evidence_company_fkey')) <> 7
      then 'CRITICAL — a composite company-scoped foreign key is missing; a child row '
        || 'can cite another tenant''s parent while carrying its own company id'
    -- If the old single-column FKs came back they would coexist with the
    -- composite ones and the weaker one would not be noticed.
    when exists (select 1 from pg_constraint
                 where conname in ('seo_tasks_project_id_fkey',
                                   'seo_task_publications_task_id_fkey',
                                   'seo_measurements_task_id_fkey',
                                   'seo_measurements_project_id_fkey'))
      then 'CRITICAL — a single-column FK was reintroduced alongside the composite one'
    when not exists (select 1 from pg_constraint where conname='seo_projects_id_company_key')
      then 'MISSING — seo_projects (id, company_entity_id) unique key'
    when not exists (select 1 from pg_constraint where conname='page_inspections_id_company_key')
      then 'MISSING — page_inspections (id, company_entity_id) unique key'
    -- The baseline invariant needs BOTH directions: either row can arrive
    -- second. With only the measurement-side trigger, the ordering could be
    -- established and then invalidated by a later publication.
    when not exists (select 1 from pg_trigger
                     where tgname='trg_check_publication_after_baselines' and not tgisinternal)
      then 'CRITICAL — publications are not checked against existing baselines; the '
        || 'baseline invariant can be bypassed by recording the publication second'
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='seo_baseline_conflicts')
      then 'MISSING — seo_baseline_conflicts(), the shared definition both triggers use'
    -- Same-day windows. Publication carries a time, a daily window does not, so
    -- >= is required: a baseline ending on the publication date straddles it.
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='seo_baseline_conflicts'
                       and pg_get_functiondef(p.oid) like '%>=%')
      then 'CRITICAL — seo_baseline_conflicts no longer rejects a baseline ending ON '
        || 'the publication date'
    -- The allowlist comment must not go back to claiming the host check alone
    -- excludes private addresses. It does not: it stops an attacker NAMING one.
    when not exists (select 1 from pg_description d
                     join pg_class c on c.oid = d.objoid
                     where c.relname='shopify_shop_domains' and d.objsubid=0
                       and d.description like '%necessary and NOT sufficient%')
      then 'MISSING — shopify_shop_domains comment no longer states the allowlist is '
        || 'insufficient on its own; address validation at fetch time is what covers it'
    else 'ok'
  end as seo_workflow_integrity;

-- ── SEO measurement capture (20260914120000) ─────────────────────────────────
-- The doc promised a deterministic baseline function since 2026-09-08 and none
-- existed; these are the pieces that make a measurement reproducible and the
-- publication sequence enforced. Losing any one of them removes a guarantee
-- without removing a table.
select
  case
    when to_regprocedure('public.seo_capture_measurements(uuid,text,date,date)') is null
      then 'MISSING — seo_capture_measurements(); run 20260914120000_seo_measurement_capture.sql'
    when to_regprocedure('public.seo_follow_up_window(uuid,integer)') is null
      then 'MISSING — seo_follow_up_window()'
    when has_function_privilege('anon', 'public.seo_capture_measurements(uuid,text,date,date)', 'execute')
      or has_function_privilege('anon', 'public.seo_follow_up_window(uuid,integer)', 'execute')
      then 'CRITICAL — anon can execute an SEO measurement function'
    when not has_function_privilege('authenticated', 'public.seo_capture_measurements(uuid,text,date,date)', 'execute')
      then 'MISSING — authenticated cannot execute seo_capture_measurements'
    -- SECURITY DEFINER is load-bearing the other way round: the insert policy
    -- refuses the two captured sources from every client, so the function is
    -- the only writer of a captured number. An INVOKER version would be
    -- refused by that policy and the capture would silently stop working.
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public' and p.proname = 'seo_capture_measurements' and p.prosecdef)
      then 'CRITICAL — seo_capture_measurements is not SECURITY DEFINER; the insert policy would refuse its own writes'
    when not exists (select 1 from pg_policies
                     where schemaname = 'public' and tablename = 'seo_measurements'
                       and policyname = 'seo_measurements_insert'
                       and with_check like '%search_console_page%' and with_check like '%shopify_landing_pages%')
      then 'CRITICAL — seo_measurements_insert lets a client type in a captured source; a baseline is only as reproducible as the function'
    when not exists (select 1 from pg_indexes
                     where schemaname = 'public' and tablename = 'seo_measurements'
                       and indexname = 'seo_measurements_capture_identity')
      then 'MISSING — seo_measurements_capture_identity; a concurrent capture can duplicate a frozen window'
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public' and p.proname = 'check_publication_after_baselines'
                       and pg_get_functiondef(p.oid) like '%follow_up%')
      then 'CRITICAL — a correction publication can land inside an existing follow-up window'
    -- Publication requires approval (the converse of invariant 1) and cannot
    -- be future-dated.
    when not exists (select 1 from pg_trigger where tgname = 'trg_seo_publication_admissible' and not tgisinternal)
      then 'CRITICAL — a publication can be recorded for an unapproved task; trg_seo_publication_admissible is missing'
    -- Both window kinds are ordered: baseline before the first publication,
    -- follow-up after the last. The one-sided predecessor must be gone.
    when not exists (select 1 from pg_trigger where tgname = 'trg_seo_measurement_window' and not tgisinternal)
      then 'CRITICAL — seo_measurements windows are not ordered against publications; trg_seo_measurement_window is missing'
    when exists (select 1 from pg_trigger where tgname = 'trg_seo_baseline_precedes_publication' and not tgisinternal)
      then 'STALE — the one-sided baseline trigger is still attached beside the two-sided one'
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public' and p.proname = 'check_seo_measurement_window'
                       and pg_get_functiondef(p.oid) like '%follow_up%')
      then 'CRITICAL — check_seo_measurement_window() no longer orders follow-up windows'
    when not exists (select 1 from public.silo_chat_schema_catalog
                     where relname = 'seo_measurements' and description like '%CAPTURE, DO NOT TYPE%')
      then 'MISSING — seo_measurements catalog entry does not point the model at seo_capture_measurements()'
    else 'ok'
  end as seo_measurement_capture;

-- ── Baseline boundary is a BUSINESS date (20260909300000, corrective) ───────
-- seo_baseline_conflicts() compared a date against timestamptz::date, which
-- reads the session TimeZone, while being declared IMMUTABLE. Measured on this
-- database: '2026-09-01T02:00:00Z'::date is 2026-09-01 under UTC and
-- 2026-08-31 under America/Los_Angeles -- so the boundary the whole invariant
-- rests on moved with a connection setting, and IMMUTABLE let the planner fold
-- a result computed under one timezone for reuse under another.
select
  case
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='seo_baseline_conflicts'
                       and pg_get_functiondef(p.oid) like '%America/Los_Angeles%')
      then 'CRITICAL — seo_baseline_conflicts() no longer pins the publication date to '
        || 'the business timezone; the baseline boundary moves with the session TimeZone'
    -- The bare cast is what made it session-dependent. If it comes back the
    -- explicit conversion has been undone.
    when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                 where n.nspname='public' and p.proname='seo_baseline_conflicts'
                   and pg_get_functiondef(p.oid) ~ 'p_published[[:space:]]*::[[:space:]]*date')
      then 'CRITICAL — seo_baseline_conflicts() is back to p_published::date, which reads '
        || 'the session TimeZone'
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='seo_baseline_conflicts'
                       and p.provolatile = 'i')
      then 'MISSING — seo_baseline_conflicts() is no longer IMMUTABLE; it is called from '
        || 'triggers on both sides of the invariant and from a WHERE clause'
    else 'ok'
  end as seo_baseline_business_timezone;

-- ── Empty collections stay visible (20260909320000, corrective) ─────────────
-- The view LEFT-joined product->SKU but INNER-joined collection->membership,
-- so a collection with no products vanished -- an empty collection read as a
-- nonexistent one, the same absence mistake one join further up. Measured when
-- fixed: 45 invisible collections, 42 of them PUBLISHED to the online store.
select
  case
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='shopify_collection_skus_v'
                       and column_name='collection_is_empty')
      then 'MISSING — shopify_collection_skus_v lost collection_is_empty; published '
        || 'collection pages with no products become invisible again'
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='shopify_collection_skus_v'
                       and column_name='sku_unresolved')
      then 'MISSING — shopify_collection_skus_v lost sku_unresolved'
    -- The actual regression risk: an INNER join, or the missing_since filter
    -- moved back into the WHERE clause, silently re-hides them. Assert the
    -- outcome rather than the SQL text -- every registry collection must be
    -- reachable in the view on its FULL identity.
    when exists (select 1 from public.shopify_collections c
                 where c.missing_since is null
                   and not exists (select 1 from public.shopify_collection_skus_v v
                                   where v.company_entity_id = c.company_entity_id
                                     and v.shop_domain = c.shop_domain
                                     and v.shopify_collection_id = c.shopify_collection_id))
      then 'CRITICAL — a registry collection is missing from shopify_collection_skus_v; '
        || 'the collection->membership join is inner again (or missing_since moved to WHERE)'
    -- The two flags must stay separate facts.
    when exists (select 1 from public.shopify_collection_skus_v
                 where collection_is_empty and sku_unresolved)
      then 'MISSING — an empty collection is flagged sku_unresolved; there is nothing to '
        || 'resolve on a collection with no products, and merging the two hides which is which'
    when not exists (select 1 from public.silo_chat_schema_catalog
                     where relname='shopify_collection_skus_v'
                       and description like '%collection_is_empty%')
      then 'MISSING — catalog entry no longer explains collection_is_empty'
    else 'ok'
  end as collection_skus_empty_visibility;

-- ── A skipped sync step can be recorded (20260909340000) ─────────────
-- A manual backfill on 2026-09-09 was dispatched with sessions_days=730 AND
-- skip_sessions=true, silently resolved that in favour of the skip, and wrote
-- NO record of any kind -- then reported success. The orchestrator now files a
-- sync_jobs row for every stage a run was asked for, including the ones it
-- declined. Without this status value that insert fails the CHECK and the
-- silence comes straight back.
select
  case
    when not exists (select 1 from pg_constraint
                     where conname='sync_jobs_status_check'
                       and pg_get_constraintdef(oid) like '%skipped%')
      then 'MISSING — sync_jobs status check does not allow ''skipped''; run '
        || '20260909340000_sync_jobs_skipped_status.sql, or every requested-but-skipped '
        || 'step goes unrecorded again'
    -- 'cancelled' must survive alongside it. They are different facts: a
    -- cancelled job started and was stopped, a skipped one never started.
    when not exists (select 1 from pg_constraint
                     where conname='sync_jobs_status_check'
                       and pg_get_constraintdef(oid) like '%cancelled%')
      then 'MISSING — sync_jobs status check lost ''cancelled'' when ''skipped'' was added'
    when not exists (select 1 from pg_constraint
                     where conname='sync_jobs_status_check'
                       and pg_get_constraintdef(oid) like '%success%'
                       and pg_get_constraintdef(oid) like '%error%'
                       and pg_get_constraintdef(oid) like '%running%')
      then 'MISSING — sync_jobs status check lost one of success/error/running'
    else 'ok'
  end as sync_jobs_skipped_status;

-- ── Landing-page resume + stale-path sweep (20260909360000) ──────────
-- The sweep DELETES rows and takes a company id as an ARGUMENT, so who may
-- execute it is the whole safety story. `revoke ... from public` does not
-- cover it: Supabase's default privileges on the public schema re-grant
-- EXECUTE to anon and authenticated on any newly created function, which is
-- exactly the hole 20260904330000 closed for chat_run_readonly_query --
-- measured here too, both roles could call the sweep after the first apply.
select
  case
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='shopify_landing_pages_covered_days')
      then 'MISSING — run 20260909360000_landing_pages_resume_and_sweep.sql; without it a '
        || 'landing-page backfill silently restarts at yesterday instead of resuming'
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='shopify_landing_pages_sweep_day')
      then 'MISSING — shopify_landing_pages_sweep_day absent; restated days accumulate paths '
        || 'that have dropped out of their top N'
    when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                 where n.nspname='public' and p.proname='shopify_landing_pages_sweep_day'
                   and has_function_privilege('authenticated', p.oid, 'EXECUTE'))
      then 'CRITICAL — authenticated can EXECUTE shopify_landing_pages_sweep_day; it deletes '
        || 'rows and takes company_entity_id as an argument. Re-run the explicit revokes'
    when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                 where n.nspname='public' and p.proname like 'shopify_landing_pages_%'
                   and has_function_privilege('anon', p.oid, 'EXECUTE'))
      then 'CRITICAL — anon can EXECUTE a shopify_landing_pages_* function'
    -- Both must stay INVOKER. As DEFINER the sweep would bypass RLS entirely
    -- and its company_entity_id argument would become a cross-tenant delete.
    when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                 where n.nspname='public' and p.proname like 'shopify_landing_pages_%'
                   and p.prosecdef)
      then 'CRITICAL — a shopify_landing_pages_* function is SECURITY DEFINER; the sweep must '
        || 'run under the caller''s RLS or its company id argument is a cross-tenant delete'
    else 'ok'
  end as landing_pages_resume_and_sweep;

-- ── SEO collection candidates (20260909380000) ───────────────────────
-- The function Ask SILO starts every on-page SEO review from. Its safety
-- property is the shop-scoped host join, not the SSRF allowlist: two primary
-- hosts under one company means a path from store A paired with store B's
-- domain fetches successfully and reports on the wrong store.
select
  case
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='seo_collection_candidates')
      then 'MISSING — run 20260909380000_seo_collection_candidates.sql'
    when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                 where n.nspname='public' and p.proname='seo_collection_candidates' and p.prosecdef)
      then 'CRITICAL — seo_collection_candidates is SECURITY DEFINER; it must run under the '
        || 'caller''s RLS or it reads every tenant''s landing pages'
    when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                 where n.nspname='public' and p.proname='seo_collection_candidates'
                   and has_function_privilege('anon', p.oid, 'EXECUTE'))
      then 'CRITICAL — anon can EXECUTE seo_collection_candidates'
    -- The load-bearing join, asserted on OUTCOME: every returned row's host
    -- must be registered to that row's own shop, never a sibling store's.
    when exists (
      select 1 from public.seo_collection_candidates(90) c
      where c.storefront_host is not null
        and not exists (select 1 from public.shopify_shop_domains d
                        where d.host = c.storefront_host
                          and d.shop_domain = c.shop_domain))
      then 'CRITICAL — a candidate row carries a host that is not registered to its own shop; '
        || 'the inspect_url would fetch the wrong store'
    -- A subpath is a product page and must never be offered as a collection.
    when exists (select 1 from public.seo_collection_candidates(90)
                 where landing_page_path !~ '^/collections/[^/?#]+$')
      then 'MISSING — a non-root path leaked into seo_collection_candidates'
    -- Coverage must be DATASET-level, not per page. Per-page counts reported as
    -- coverage read as "SILO only holds N days", misstating the evidence base.
    when not exists (select 1 from information_schema.routines r
                     join information_schema.parameters pa on pa.specific_name = r.specific_name
                     where r.routine_schema='public' and r.routine_name='seo_collection_candidates'
                       and pa.parameter_name = 'source_days_available')
      then 'MISSING — seo_collection_candidates lost source_days_available; page presence would '
        || 'again be reported as dataset coverage'
    when exists (select 1 from public.seo_collection_candidates(90)
                 where page_days_present > source_days_available)
      then 'CRITICAL — a page is present on more days than the dataset covers; the coverage '
        || 'CTE is per-page again'
    -- Pacific completed days only: a partial day must never enter a window a
    -- person reads as "the last 90 days".
    when exists (select 1 from public.seo_collection_candidates(90)
                 where source_latest_day >= public.silo_business_today())
      then 'CRITICAL — the window includes today (Pacific); the upper bound is not exclusive '
        || 'or the function is back on current_date'
    when not exists (select 1 from public.seo_collection_candidates(90)
                     where candidate_status is not null)
      then 'MISSING — candidate_status is absent; an unpublished or unregistered page would be '
        || 'offered for a copy rewrite'
    -- The day columns must carry their own caveat. Named page_first_day they
    -- were read as a launch date on the first live run, producing "since
    -- launch on 2026-08-13" for a collection that had sold for two weeks
    -- before that.
    when not exists (select 1 from information_schema.routines r
                     join information_schema.parameters pa on pa.specific_name = r.specific_name
                     where r.routine_schema='public' and r.routine_name='seo_collection_candidates'
                       and pa.parameter_name = 'page_first_day_in_top_n')
      then 'MISSING — the day columns lost the _in_top_n suffix; a first-appearance date reads '
        || 'as a launch date without it'
    when not exists (select 1 from public.seo_collection_candidates(90)
                     where coverage_note like '%IS NOT A LAUNCH DATE%')
      then 'MISSING — coverage_note no longer warns that a first-appearance date is not a '
        || 'launch date'
    else 'ok'
  end as seo_collection_candidates;

-- ── Tasks on initiatives (20260910120000) ─────────────────────────────────
select
  case
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='launch_tasks'
                       and column_name='channel_item_id')
      then 'MISSING — launch_tasks.channel_item_id; a task cannot be attached to an initiative'
    -- CASCADE, by the owner's decision (20260910140000): deleting an initiative
    -- deletes its tasks, the same gesture as deleting a launch. A task tied to
    -- neither survives both, which needs no rule -- it references nothing.
    when not exists (select 1 from pg_constraint
                     where conrelid='public.launch_tasks'::regclass and contype='f'
                       and conname='launch_tasks_channel_item_id_fkey'
                       and pg_get_constraintdef(oid) ilike '%on delete cascade%')
      then 'CRITICAL — the initiative link is not ON DELETE CASCADE; deleting an initiative '
        || 'would strand its tasks instead of removing them'
    when not exists (select 1 from pg_trigger
                     where tgrelid='public.launch_tasks'::regclass
                       and tgname='trg_task_launch_from_initiative')
      then 'MISSING — trg_task_launch_from_initiative; launch_id and channel_item_id can now '
        || 'disagree about which launch a task is on'
    -- Without this, the derivation is only true at write time: move an
    -- initiative to another launch and its tasks stay pointing at the old one.
    when not exists (select 1 from pg_trigger
                     where tgrelid='public.launch_channel_items'::regclass
                       and tgname='trg_initiative_move_resyncs_tasks')
      then 'MISSING — trg_initiative_move_resyncs_tasks; moving an initiative would strand '
        || 'its tasks on the previous launch'
    when not exists (select 1 from pg_views where schemaname='public' and viewname='tasks_v')
      then 'MISSING — tasks_v'
    -- security_invoker is NOT optional: launch_tasks hides private tasks from
    -- all but their assignee and creator, and a definer view would hand every
    -- private task to the whole company.
    when not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
                     where n.nspname='public' and c.relname='tasks_v'
                       and c.reloptions::text ilike '%security_invoker=true%')
      then 'CRITICAL — tasks_v is not security_invoker; private tasks would be visible '
        || 'company-wide'
    -- The row that proves the derivation still holds in live data.
    when exists (select 1 from public.launch_tasks t
                 join public.launch_channel_items ci on ci.id = t.channel_item_id
                 where t.launch_id is distinct from ci.launch_id)
      then 'CRITICAL — a task disagrees with its initiative about the launch'
    else 'ok'
  end as tasks_on_initiatives;

-- ── Finance V1 approval + posting controls (20260912000000) ───────────────
select
  case
    when not exists (select 1 from information_schema.columns
      where table_schema='public' and table_name='card_import_batches'
        and column_name='approval_snapshot')
      then 'MISSING — card approval snapshots'
    when not exists (select 1 from information_schema.columns
      where table_schema='public' and table_name='journal_adjustments'
        and column_name='approval_snapshot')
      then 'MISSING — adjustment approval snapshots'
    when not exists (select 1 from information_schema.columns
      where table_schema='public' and table_name='quickbooks_journal_postings'
        and column_name='request_key')
      then 'MISSING — durable QBO request identity'
    when not exists (select 1 from pg_indexes
      where schemaname='public' and indexname='uq_quickbooks_postings_active_claim'
        and indexdef ilike '%submitting%' and indexdef ilike '%unknown%'
        and indexdef ilike '%posted%')
      then 'CRITICAL — QBO unknown/submitting outcomes do not retain the duplicate-post lock'
    when not exists (select 1 from pg_indexes
      where schemaname='public' and indexname='uq_journal_adjustments_active_source')
      then 'MISSING — generated journal source identity is not unique'
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='approve_card_import_batch')
      then 'MISSING — server-side card approval RPC'
    when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='approve_journal_adjustment')
      then 'MISSING — server-side adjustment approval RPC'
    when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public'
        and p.proname in ('approve_card_import_batch','approve_journal_adjustment',
          'reopen_card_import_batch','reopen_journal_adjustment')
        and (has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('public', p.oid, 'execute')))
      then 'CRITICAL — a finance approval RPC is callable by anon/PUBLIC'
    when not exists (select 1 from pg_policies
      where schemaname='public' and tablename='card_import_batches'
        and policyname='card_import_batches_update_draft'
        and with_check ilike '%status = ANY%draft%categorized%')
      then 'CRITICAL — browser writes can still create an approved card batch'
    when not exists (select 1 from pg_policies
      where schemaname='public' and tablename='journal_adjustments'
        and policyname='journal_adjustments_update_draft'
        and with_check ilike '%status = ''draft''%')
      then 'CRITICAL — browser writes can still create an approved adjustment'
    else 'ok'
  end as finance_v1_posting_controls;

-- The edge function verifies the stored approval, without reserializing jsonb.
with hash_rpc as (
  select p.* from pg_proc p
  where p.oid = to_regprocedure('public.finance_approval_hash_matches(text,uuid,text,bigint)')
)
select case
  when not exists (select 1 from hash_rpc)
    then 'MISSING — stored approval hash verification RPC'
  when exists (select 1 from hash_rpc p where p.prosecdef or p.prorettype <> 'boolean'::regtype)
    then 'CRITICAL — approval verification must be an invoker boolean RPC'
  when exists (select 1 from hash_rpc p where
    has_function_privilege('anon', p.oid, 'execute')
    or has_function_privilege('authenticated', p.oid, 'execute')
    or not has_function_privilege('service_role', p.oid, 'execute')
    or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where a.grantee = 0 and a.privilege_type = 'EXECUTE'))
    then 'CRITICAL — stored approval verification must be service-role only'
  when not exists (select 1 from hash_rpc p where
    pg_get_functiondef(p.oid) like '%finance_approval_snapshot_hash(b.approval_snapshot)%'
    and pg_get_functiondef(p.oid) like '%finance_approval_snapshot_hash(a.approval_snapshot)%'
    and pg_get_functiondef(p.oid) like '%approval_hash = p_expected_hash%'
    and pg_get_functiondef(p.oid) like '%approval_version = p_expected_version%')
    then 'CRITICAL — approval verification must bind the stored snapshot to its loaded revision'
  else 'ok'
end as finance_approval_stored_hash;

-- Typed generated sources and legacy adjustment UUIDs share the same void RPC.
with void_rpc as (
  select p.* from pg_proc p
  where p.oid = to_regprocedure('public.void_journal_adjustment(uuid,text)')
)
select case
  when not exists (select 1 from void_rpc)
    then 'MISSING — reasoned adjustment void RPC'
  when exists (select 1 from void_rpc p where
    has_function_privilege('anon', p.oid, 'execute')
    or not has_function_privilege('authenticated', p.oid, 'execute')
    or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where a.grantee = 0 and a.privilege_type = 'EXECUTE'))
    then 'CRITICAL — adjustment void authorization grant is incorrect'
  when not exists (select 1 from void_rpc p where
    pg_get_functiondef(p.oid) like '%v_user is null%'
    and pg_get_functiondef(p.oid) like '%can_manage_journal_entries()%'
    and pg_get_functiondef(p.oid) like '%approval_snapshot->>''source''%'
    and pg_get_functiondef(p.oid) like '%accounting_source_ref%'
    and pg_get_functiondef(p.oid) like '%''journal_adjustment''%'
    and pg_get_functiondef(p.oid) like '%p.id = v_adj.posting_id%'
    and pg_get_functiondef(p.oid) like '%p.payload_hash = v_adj.approval_hash%'
    and pg_get_functiondef(p.oid) like '%p.connection_id = v_connection%'
    and pg_get_functiondef(p.oid) like '%for update%'
    and pg_get_functiondef(p.oid) like '%v_reason is null%'
    and pg_get_functiondef(p.oid) like '%recovery_note = concat_ws%')
    then 'CRITICAL — adjustment void does not bind its exact posting and preserve the reason'
  else 'ok'
end as finance_adjustment_void_contract;

-- Meta ad destinations. The pairing is the check that matters: an unattributed
-- URL cannot be told apart from a page-post URL standing in for a landing
-- page, which is the one way this feature can quietly say something false.
select 'Meta creative destination' as check_name,
 case when to_regclass('public.meta_ad_creatives') is null then 'MISSING: meta ad creative migration'
 when not exists(select 1 from information_schema.columns where table_schema='public'
   and table_name='meta_ad_creatives' and column_name='link_url')
   then 'MISSING: link_url; apply 20260915140000'
 when not exists(select 1 from pg_constraint
   where conrelid=to_regclass('public.meta_ad_creatives')
     and conname='meta_ad_creatives_link_source_together')
   then 'CRITICAL: link_url may be stored without the source that says how it was resolved'
 -- Generated, so link_path cannot drift from the URL it describes. A plain
 -- column here would be a second copy of the same derivation.
 when not exists(select 1 from information_schema.columns where table_schema='public'
   and table_name='meta_ad_creatives' and column_name='link_path'
   and is_generated='ALWAYS')
   then 'CRITICAL: link_path is not a generated column; it can drift from link_url'
 -- The view lists its columns explicitly, so a create-or-replace that forgets
 -- one makes every ad look like it has no destination rather than erroring.
 when not exists(select 1 from information_schema.columns where table_schema='public'
   and table_name='meta_ad_performance_v' and column_name='link_url')
   then 'STALE: meta_ad_performance_v does not expose link_url; re-apply 20260915140000'
 when to_regprocedure('public.wow_creatives(date,text,int)') is not null
   and pg_get_functiondef(to_regprocedure('public.wow_creatives(date,text,int)')) not like '%link_url_source%'
   then 'STALE: wow_creatives does not carry the destination; apply 20260915150000'
 -- The drift this change reconciled: production carried these and the repo did
 -- not, so a rebuild from an older file silently deletes them.
 when to_regprocedure('public.wow_creatives(date,text,int)') is not null
   and pg_get_functiondef(to_regprocedure('public.wow_creatives(date,text,int)')) not like '%cost_per_thruplay%'
   then 'CRITICAL: wow_creatives has lost thruplays/leads; the Marketing Report reads them by name'
 else 'ok' end as status;

-- /v2/products.html: a Pipeline item can record the PO it came from. (The
-- youth/adult snapback split that shipped alongside this is purely client-side
-- vocabulary in the size columns -- there is no constraint here to assert.)
select 'Product tracker PO link' as check_name,
 case when to_regclass('public.product_tracker') is null then 'MISSING: product_tracker table'
 when not exists(select 1 from information_schema.columns where table_schema='public'
   and table_name='product_tracker' and column_name='po_header_id')
   then 'MISSING: product_tracker.po_header_id; apply 20260915230000'
 -- Without the FK the column is a free-text uuid: a PO id that no longer
 -- exists would keep reading as a live link on every Pipeline drawer.
 when not exists(select 1 from pg_constraint c
   where c.conrelid=to_regclass('public.product_tracker') and c.contype='f'
     and c.confrelid=to_regclass('public.po_headers')
     and c.conkey = array[(select attnum from pg_attribute
       where attrelid=to_regclass('public.product_tracker') and attname='po_header_id')])
   then 'CRITICAL: product_tracker.po_header_id has no FK to po_headers'
 -- cascade would delete a pipeline item along with its PO. The pipeline item
 -- is the record of the product, not of the order.
 when exists(select 1 from pg_constraint c
   where c.conrelid=to_regclass('public.product_tracker') and c.contype='f'
     and c.confrelid=to_regclass('public.po_headers') and c.confdeltype <> 'n')
   then 'CRITICAL: product_tracker.po_header_id does not use ON DELETE SET NULL'
 else 'ok' end as status;

-- Did the newest Meta creative sync actually resolve any ad destinations?
--
-- THE ALARM THAT WAS MISSING. The feature's first production run resolved
-- 0 of 126 -- one refused field dropped every other, including the one the
-- account accepts -- and the only thing that said so was a log line a person
-- happened to paste. This makes the same collapse fail the daily drift check.
--
-- Quiet until a sync has actually run (a fresh database has no rows and is not
-- broken), and judged only on the newest window, since older rows predate the
-- feature and are legitimately null. Coverage is partial by nature -- 82 of 126
-- on 2026-09-16, because VIDEO and some SHARE ads expose no destination field
-- at all -- so this deliberately fires on ZERO, not on a threshold: a number
-- nobody can justify would be tuned until it stopped firing.
select 'Meta ad destination coverage' as check_name,
 case when to_regclass('public.meta_ad_creatives') is null then 'MISSING: meta ad creative migration'
 when not exists(select 1 from information_schema.columns where table_schema='public'
   and table_name='meta_ad_creatives' and column_name='link_url')
   then 'MISSING: link_url; apply 20260915140000'
 when not exists(select 1 from public.meta_ad_creatives
   where synced_at > now() - interval '3 days')
   then 'ok'
 when not exists(select 1 from public.meta_ad_creatives
   where link_url is not null and synced_at > now() - interval '3 days')
   then 'CRITICAL: the newest Meta creative sync resolved NO ad destinations; a field the account accepts was probably dropped alongside a refused one -- read the run log line [asked: ..., refused: ...]'
 else 'ok' end as status;

-- Is Ask SILO still being told the disproved thing about ad destinations?
--
-- 20260915140000 taught the catalog that effective_object_url is the source
-- page-post ads "rely on", which a live sync disproved: the account refuses
-- that field outright and every resolved destination comes from
-- asset_feed_spec. 20260916030000 corrects the sentence with a targeted
-- replace -- which NO-OPS SILENTLY if production's text has drifted from what
-- the migration expects, leaving the wrong claim in the model's prompt with
-- nothing to show for it.
--
-- So this asserts the outcome rather than trusting the update, and it doubles
-- as a guard against a later migration reintroducing the claim. Same stance as
-- the Search Console caveat that verify goes CRITICAL on if it returns.
select 'Ask SILO ad destination caveat' as check_name,
 case when to_regclass('public.silo_chat_schema_catalog') is null then 'MISSING: schema catalog'
 when not exists(select 1 from public.silo_chat_schema_catalog
   where relname = 'meta_ad_performance_v')
   then 'STALE: meta_ad_performance_v is not in the Ask SILO catalog; run refresh_chat_schema_catalog()'
 when exists(select 1 from public.silo_chat_schema_catalog
   where relname = 'meta_ad_performance_v'
     and description like '%that relies on it%')
   then 'CRITICAL: the catalog still tells Ask SILO that page-post ads rely on effective_object_url, which this account refuses; apply 20260916030000'
 when not exists(select 1 from public.silo_chat_schema_catalog
   where relname = 'meta_ad_performance_v'
     and description like '%link_url_source%')
   then 'STALE: the catalog no longer explains link_url_source; a later migration replaced the description instead of appending'
 else 'ok' end as status;

-- Ask SILO evidence scope + diagnostics (20260916140000).
--
-- Three things, all of which failed silently rather than loudly when they were
-- wrong, which is why they are asserted here rather than left to a reader.
--
--  1. silo_chat_audit_log.diagnostics. The edge function retries its insert
--     WITHOUT this column when it is missing, so a forgotten migration costs
--     diagnostics with no error anywhere -- exactly the "prod is not what the
--     repo claims" gap deployment-drift-check.yml exists for.
--  2. The view's explicit column list. A `create or replace view` that drops
--     the column does not error; every reader just keeps seeing the old shape.
--     Same trap request_id documented.
--  3. The stale coverage claim staying gone. A card that states its own
--     history depth in words cannot notice that it aged: this one said "about
--     7 weeks, from 2026-07-08, too shallow for launch comps" over a table
--     holding 415 days back to 2025-07-28, and steered questions off it. A
--     replacement RANGE would age identically, so the check is that no
--     hardcoded range returns at all, not that a newer one is present.
select 'Ask SILO evidence scope' as check_name,
 case when to_regclass('public.silo_chat_audit_log') is null then 'MISSING: silo_chat_audit_log'
 when not exists(select 1 from information_schema.columns where table_schema='public'
   and table_name='silo_chat_audit_log' and column_name='diagnostics')
   then 'MISSING: silo_chat_audit_log.diagnostics; apply 20260916140000'
 when not exists(select 1 from information_schema.columns where table_schema='public'
   and table_name='silo_chat_audit_log_v' and column_name='diagnostics')
   then 'MISSING: silo_chat_audit_log_v does not expose diagnostics; a create-or-replace dropped it'
 when to_regclass('public.silo_chat_schema_catalog') is null then 'MISSING: schema catalog'
 when exists(select 1 from public.silo_chat_schema_catalog
   where relname = 'meta_ad_performance_daily'
     and description ~* '(weeks of history|from 20[0-9]{2}-[0-9]{2}-[0-9]{2}\)|do not use it for launch comps)')
   then 'CRITICAL: the Meta ad-level card states a hardcoded coverage range again; coverage is measured by describe_relations, never written into a card'
 when not exists(select 1 from public.silo_chat_schema_catalog
   where relname = 'meta_ad_performance_daily'
     and description like '%COVERAGE IS MEASURED, NEVER REMEMBERED%')
   then 'STALE: the Meta ad-level card lost its measure-it-first instruction; a later migration replaced the description instead of appending'
 when not exists(select 1 from public.silo_chat_schema_catalog
   where relname = 'marketing_daily_totals_v'
     and description like '%ALREADY COMBINED ACROSS PLATFORMS%')
   then 'STALE: marketing_daily_totals_v no longer warns that its figures pool every platform'
 else 'ok' end as status;

-- Can the Meta creative backfill even record a run?
--
-- scripts/meta-creative-backfill.mjs opens a sync_jobs row with job_type
-- 'meta_creative_backfill' before it fetches anything, so without
-- 20260916150000 the whole backfill dies on its first statement with a CHECK
-- violation. That is a loud failure rather than a silent one -- but it fails
-- at the moment someone runs a 3-hour job they wanted the results of, which
-- is the worst time to discover a migration was never applied. The daily
-- drift check reads this instead.
--
-- Asserted by TRYING the value against the live constraint rather than by
-- pattern-matching its text: a CHECK can be rewritten in any number of
-- equivalent ways, and what matters is whether the insert would be allowed.
select 'Meta creative backfill job type' as check_name,
 case when to_regclass('public.sync_jobs') is null then 'MISSING: sync_jobs'
 when not exists(
   select 1 from pg_constraint
   where conrelid = 'public.sync_jobs'::regclass and contype = 'c'
     and conname = 'sync_jobs_job_type_check'
     and pg_get_constraintdef(oid) like '%meta_creative_backfill%')
   then 'MISSING: sync_jobs.job_type does not accept meta_creative_backfill; apply 20260916150000'
 else 'ok' end as status;

-- Is Ask SILO still telling people a catalog ad has no destination?
--
-- 20260916030000 wrote a coverage caveat onto meta_ad_performance_v's catalog
-- description, and that text reaches the model VERBATIM. It asserted that the
-- ads which resolved nothing "expose no destination field at all" -- an
-- inference drawn from a single 126-ad window, and DISPROVED on 2026-09-17
-- when the probe found 14 of 14 such ads carrying one in template_data or on
-- the page post. It also claimed "no UTMs on any ad" while 759 carry them.
--
-- 20260917120000 replaces that block. A targeted replace NO-OPS SILENTLY when
-- production's text has drifted from what it expects, which would leave the
-- disproved claim in the prompt with nothing to show for it -- so this asserts
-- the OUTCOME rather than trusting the update, and doubles as a guard against
-- a later migration reintroducing it.
select 'Ask SILO ad destination coverage claim' as check_name,
 case when to_regclass('public.silo_chat_schema_catalog') is null then 'MISSING: schema catalog'
 when not exists(select 1 from public.silo_chat_schema_catalog
   where relname = 'meta_ad_performance_v')
   then 'STALE: meta_ad_performance_v is not in the Ask SILO catalog; run refresh_chat_schema_catalog()'
 when exists(select 1 from public.silo_chat_schema_catalog
   where relname = 'meta_ad_performance_v'
     and description like '%expose no destination field at all%')
   then 'CRITICAL: the catalog still tells Ask SILO those ads have no destination field, which the 2026-09-17 probe disproved; apply 20260917120000'
 when exists(select 1 from public.silo_chat_schema_catalog
   where relname = 'meta_ad_performance_v'
     and description like '%no UTMs on any ad%')
   then 'CRITICAL: the catalog still claims no ad carries UTMs; 759 do. Apply 20260917120000'
 when not exists(select 1 from public.silo_chat_schema_catalog
   where relname = 'meta_ad_performance_v'
     and description like '%template_data%')
   then 'STALE: the catalog does not name template_data as a destination source; a later migration replaced the description instead of appending'
 else 'ok' end as status;

-- Demand Planner candidate ledger. Placed ABOVE the Plaid marker on purpose --
-- see the note at the end of this file: everything after that marker is
-- executed by the Plaid fixture, which does not build this schema.
select 'Forecast candidate ledger' as check_name,
 case when to_regclass('public.forecast_candidate_ledger') is null then 'MISSING: forecast candidate ledger migration'
 when not (select relrowsecurity from pg_class where oid=to_regclass('public.forecast_candidate_ledger'))
   then 'CRITICAL: forecast_candidate_ledger RLS disabled'
 -- The ledger's whole value is that a frozen forecast cannot be restated. The
 -- runner writes with the service role, which bypasses RLS, so immutability
 -- lives in the trigger or nowhere.
 when not exists(select 1 from pg_trigger where tgrelid=to_regclass('public.forecast_candidate_ledger')
   and tgname='forecast_candidate_ledger_append_only' and tgenabled<>'D')
   then 'CRITICAL: the append-only trigger is missing or disabled; a frozen forecast can be rewritten'
 -- Idempotency: without this a re-run writes a second, differently-computed
 -- number for the same decision.
 when not exists(select 1 from pg_class where relname='forecast_candidate_ledger_identity_uq' and relkind='i')
   then 'CRITICAL: the candidate/category/horizon/cutoff unique index is missing'
 when not exists(select 1 from pg_constraint where conrelid=to_regclass('public.forecast_candidate_ledger')
   and conname='forecast_ledger_no_lookahead')
   then 'CRITICAL: the no-look-ahead constraint is missing'
 -- Without this a dropped monthly run is not a gap but a licence: the next
 -- run's catch-up would freeze a cutoff whose outcome is already complete, and
 -- the scorer would count it as prospective evidence toward promotion.
 when not exists(select 1 from pg_constraint where conrelid=to_regclass('public.forecast_candidate_ledger')
   and conname='forecast_ledger_frozen_before_outcome' and convalidated)
   then 'CRITICAL: the frozen-before-outcome constraint is missing or NOT VALID; a forecast can be written after its own outcome'
 -- Any row that slipped in before the constraint existed is retrospective
 -- evidence wearing a prospective label.
 when exists(select 1 from public.forecast_candidate_ledger
   where executed_at >= timezone('America/Los_Angeles', horizon_end_date::timestamp))
   then 'CRITICAL: a ledger row was frozen at or after its own horizon closed'
 -- Recording the issuance lag protects nothing unless the scorer reads it: a
 -- forecast issued on day 16 is otherwise scored against the whole month,
 -- including the half that had already elapsed before it existed.
 when not exists(select 1 from information_schema.columns where table_schema='public'
   and table_name='forecast_candidate_ledger' and column_name='max_issuance_lag_days')
   then 'MISSING: the issuance-lag bound column'
 when (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='forecast_candidate_cycles') not like '%frozen_days_into_horizon > r.max_issuance_lag_days%'
   then 'CRITICAL: the scorer does not gate on the issuance lag; a forecast issued mid-month still counts toward promotion'
 -- Supabase's default privileges grant ALL on a new public table. With RLS and
 -- no policy an UPDATE then succeeds with ZERO ROWS, which reads exactly like a
 -- write that worked, so the revoke has to be explicit.
 when has_table_privilege('authenticated','public.forecast_candidate_ledger','UPDATE')
   or has_table_privilege('authenticated','public.forecast_candidate_ledger','INSERT')
   or has_table_privilege('authenticated','public.forecast_candidate_ledger','DELETE')
   then 'CRITICAL: authenticated can write to forecast_candidate_ledger directly'
 when has_table_privilege('anon','public.forecast_candidate_ledger','SELECT')
   then 'CRITICAL: anon can read forecast_candidate_ledger'
 else 'ok' end as status;

select 'Forecast candidate authorization' as check_name,
 case when to_regprocedure('public.forecast_yoy_shift_v1(uuid,date,text,integer,numeric,numeric)') is null
   then 'MISSING: forecast candidate migration'
 -- The engine functions take an explicit company id. They shipped first as
 -- SECURITY DEFINER functions asking pg_has_role(current_user,'service_role')
 -- -- and inside a definer function current_user is the OWNER, so that
 -- answered yes for every signed-in user. Authorization is the GRANT now; this
 -- asserts it.
 --
 -- Matched by NAME over pg_proc rather than by a written-out signature. Two
 -- reasons, one of which already bit: a hardcoded signature ERRORS rather than
 -- failing when the function's arguments change (adding the issuance-lag
 -- parameter left this check naming a 7-argument form the migration had
 -- dropped, so verify would have thrown after apply instead of reporting.
 -- (Note this comment deliberately does not end in a semicolon: the splitter
 -- that sends this file to production counts end-of-line terminators, and a
 -- comment shaped like one breaks that invariant.)
 -- and a signature names ONE overload, so a leftover or newly added one would
 -- keep its grants with nothing noticing. Every overload of these names must
 -- be unreachable from a browser role, whatever its arguments.
 when exists (
   select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('forecast_yoy_shift_v1', 'record_forecast_candidate_run',
                       'forecast_actuals_matured_through')
     and (has_function_privilege('authenticated', p.oid, 'EXECUTE')
       or has_function_privilege('anon', p.oid, 'EXECUTE')))
   then 'CRITICAL: an engine function (forecast_yoy_shift_v1 / record_forecast_candidate_run / forecast_actuals_matured_through) is callable by a browser role; they take an arbitrary company id'
 -- ...and the in-function gate must NOT go back to inferring the caller's role.
 when (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='forecast_candidate_may_act') like '%pg_has_role%'
   then 'CRITICAL: the tenant gate is inferring the caller role again; inside SECURITY DEFINER that is always the owner'
 -- The planner-facing side, also by name: at least one overload must be
 -- reachable, and none of them may be reachable by anon.
 when not exists (
   select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'evaluate_forecast_candidate'
     and has_function_privilege('authenticated', p.oid, 'EXECUTE'))
   then 'CRITICAL: a planner cannot read the promotion recommendation'
 when exists (
   select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('evaluate_forecast_candidate', 'forecast_candidate_cycles',
                       'void_forecast_candidate_run')
     and has_function_privilege('anon', p.oid, 'EXECUTE'))
   then 'CRITICAL: a planner-facing forecast function is callable by anon'
 -- Voiding removes a result from scoring, and a void can turn a HOLD into a
 -- pass by deleting the cycle that broke the streak. Same-company is not a
 -- permission: this must require exec/owner, and deliberately NOT
 -- is_admin_user(), which nearly the whole company passes.
 when (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='void_forecast_candidate_run') not like '%is_exec_or_owner%'
   then 'CRITICAL: voiding a frozen forecast is not gated on exec/owner; any member can exclude an unfavourable cycle'
 -- The writer must decide expiry by the CALENDAR too, not only by data
 -- maturity: when the sync lags, the two disagree and the insert hits the
 -- table constraint instead, turning a late sync into a failed job.
 when (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='record_forecast_candidate_run') not like '%now())::date >= v_horizon_end%'
   then 'CRITICAL: the writer has no wall-clock expiry test; a lagging sync will raise a constraint violation instead of reporting expired'
 else 'ok' end as status;

select 'Forecast candidate baselines' as check_name,
 case when to_regclass('public.forecast_model_baselines') is null then 'MISSING: forecast baseline table'
 when not (select relrowsecurity from pg_class where oid=to_regclass('public.forecast_model_baselines'))
   then 'CRITICAL: forecast_model_baselines RLS disabled'
 -- An absent baseline must read as "not recorded" and never as "beaten".
 -- Baseballism's two measured rows come from report f98754f7; if they are gone
 -- the promotion gate cannot compare against anything.
 when not exists(select 1 from public.forecast_model_baselines
   where baseline_key='portfolio' and horizon_days=30)
   then 'STALE: no 30-day portfolio baseline recorded; the promotion gate has nothing to compare against'
 when not exists(select 1 from public.forecast_model_baselines
   where baseline_key='category' and sku_category='Youth' and horizon_days=30)
   then 'STALE: no 30-day Youth baseline recorded'
 else 'ok' end as status;

select 'Forecastable product types (modelled, not hardcoded)' as check_name,
 case when to_regclass('public.product_type_profile') is null
   then 'MISSING: product_type_profile; run 20260917180000_product_type_profile.sql'
 when to_regclass('public.product_type_forecastable_v') is null
   then 'MISSING: product_type_forecastable_v'
 when not (select relrowsecurity from pg_class where oid=to_regclass('public.product_type_profile'))
   then 'CRITICAL: product_type_profile RLS disabled'
 when has_table_privilege('anon','public.product_type_profile','SELECT')
   then 'CRITICAL: anon can read product_type_profile'
 -- The classification view must NOT be security_invoker. po_lines RLS is
 -- narrower than company (is_admin_user() OR created_by = auth.uid()), and
 -- "never purchased" is what separates a service line from merchandise -- so an
 -- invoker view hands a buyer and an admin DIFFERENT classifications for the
 -- same type, making the answer a property of the reader.
 when coalesce((select option_value from pg_options_to_table(
        (select reloptions from pg_class where relname='product_type_forecastable_v'))
        where option_name='security_invoker'), 'false') = 'true'
   then 'CRITICAL: product_type_forecastable_v is security_invoker; classification would vary by reader'
 -- The runner is service-role, where active_company_id() is null, so it cannot
 -- read the view at all and needs the explicit-company counterpart.
 when to_regprocedure('public.forecastable_product_types(uuid)') is null
   then 'MISSING: forecastable_product_types(uuid); the monthly runner cannot enumerate categories'
 when has_function_privilege('authenticated','public.forecastable_product_types(uuid)','EXECUTE')
   then 'CRITICAL: forecastable_product_types takes an explicit company and must be service_role only'
 -- Negative on-hand is OVERSOLD stock, which is evidence the type IS stocked.
 -- A `> 0` test classifies it as a service line and drops real merchandise from
 -- every forecast silently (caught on Canvas Totes at -253).
 when (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='forecastable_product_types') like '%coalesce(st.oh,0) > 0%'
   then 'CRITICAL: on-hand tested with > 0; oversold merchandise is misclassified as a service line'
 else 'ok' end as status;

select 'Forecast functions carry no tenant-specific default' as check_name,
 case when to_regprocedure('public.record_forecast_candidate_run(uuid,date,text,text,integer,numeric,numeric,integer)') is null
   then 'MISSING: forecast candidate migration'
 -- A default category is a claim about what is normal, and in a component meant
 -- to serve any tenant the normal category is not one company's catalogue. This
 -- matches any quoted default on a text parameter named p_sku_category.
 when exists (
   select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public'
     and p.proname in ('record_forecast_candidate_run','forecast_candidate_cycles','evaluate_forecast_candidate')
     and pg_get_function_arguments(p.oid) ~ 'p_sku_category text DEFAULT')
   then 'CRITICAL: a forecast function still defaults its product category to one tenant''s value'
 else 'ok' end as status;

select 'Forecast method selections are prospective' as check_name,
 case when to_regclass('public.forecast_method_selections') is null
   then 'MISSING: forecast_method_selections; run 20260918000000_forecast_method_competition.sql'
 when not (select relrowsecurity from pg_class where oid=to_regclass('public.forecast_method_selections'))
   then 'CRITICAL: forecast_method_selections RLS disabled'
 -- THE constraint. A selection whose evidence reaches the cutoff it governs
 -- could have been made after seeing the result it is used to justify, which is
 -- indistinguishable from no record at all. The job writes with the service
 -- role and bypasses RLS, so this has to be a CHECK.
 when not exists(select 1 from pg_constraint where conrelid=to_regclass('public.forecast_method_selections')
   and conname='fms_evidence_precedes_cutoff' and convalidated)
   then 'CRITICAL: the evidence-precedes-cutoff constraint is missing or NOT VALID'
 -- Any row that slipped in before it existed.
 when exists(select 1 from public.forecast_method_selections where evidence_to >= effective_from_cutoff)
   then 'CRITICAL: a recorded selection was made from evidence reaching its own cutoff'
 when not exists(select 1 from pg_trigger where tgrelid=to_regclass('public.forecast_method_selections')
   and tgname='forecast_method_selections_append_only' and tgenabled<>'D')
   then 'CRITICAL: the append-only trigger is missing or disabled; a recorded selection can be rewritten'
 when not exists(select 1 from pg_class where relname='forecast_method_selections_identity_uq' and relkind='i')
   then 'CRITICAL: the company/category/horizon/cutoff unique index is missing'
 when has_table_privilege('authenticated','public.forecast_method_selections','INSERT')
   or has_table_privilege('authenticated','public.forecast_method_selections','UPDATE')
   or has_table_privilege('authenticated','public.forecast_method_selections','DELETE')
   then 'CRITICAL: authenticated can write forecast_method_selections directly'
 when has_table_privilege('anon','public.forecast_method_selections','SELECT')
   then 'CRITICAL: anon can read forecast_method_selections'
 else 'ok' end as status;

select 'Forecast competition methods' as check_name,
 case when to_regclass('public.forecast_method_selections') is null
   then 'MISSING: forecast competition migration'
 -- Every method must report the newest day it read, and the ledger must bind
 -- it. The ORIGINAL no-look-ahead CHECK keys on Candidate_YoY_Shift_v1's own
 -- provenance columns, which became nullable when the ledger was generalised --
 -- and a CHECK passes trivially on NULL, so without this column the guarantee
 -- would silently apply to one method out of four.
 when not exists(select 1 from pg_attribute where attrelid=to_regclass('public.forecast_candidate_ledger')
   and attname='inputs_through_date' and attnotnull and not attisdropped)
   then 'CRITICAL: forecast_candidate_ledger.inputs_through_date is missing or nullable'
 when not exists(select 1 from pg_constraint where conrelid=to_regclass('public.forecast_candidate_ledger')
   and conname='forecast_ledger_inputs_precede_cutoff' and convalidated)
   then 'CRITICAL: the generic inputs-precede-cutoff constraint is missing or NOT VALID'
 when exists(select 1 from public.forecast_candidate_ledger where inputs_through_date >= cutoff_date)
   then 'CRITICAL: a ledger row read source data at or after its own cutoff'
 -- The scorer and the selector take an explicit company id and read that
 -- company's sales. Inside a SECURITY DEFINER function there is no way to tell
 -- a service-role caller from a user, so an authenticated grant on either is a
 -- tenant leak. Users read the RESULT through forecast_method_selections, whose
 -- RLS scopes it.
 when to_regprocedure('public.score_forecast_methods(uuid,text,integer,date,date)') is null
   then 'MISSING: score_forecast_methods'
 when has_function_privilege('authenticated','public.score_forecast_methods(uuid,text,integer,date,date)','EXECUTE')
   then 'CRITICAL: score_forecast_methods is callable by authenticated with any company id'
 when to_regprocedure('public.select_forecast_method(uuid,text,integer,date,integer,text)') is null
   then 'MISSING: select_forecast_method'
 when has_function_privilege('authenticated','public.select_forecast_method(uuid,text,integer,date,integer,text)','EXECUTE')
   then 'CRITICAL: select_forecast_method is callable by authenticated'
 when to_regprocedure('public.record_forecast_method_run(uuid,date,text,text,integer,integer)') is null
   then 'MISSING: record_forecast_method_run'
 when has_function_privilege('authenticated','public.record_forecast_method_run(uuid,date,text,text,integer,integer)','EXECUTE')
   then 'CRITICAL: record_forecast_method_run is callable by authenticated'
 -- Each competing method exists and is service-role only.
 when to_regprocedure('public.forecast_run_rate_v1(uuid,date,text,integer)') is null
   or to_regprocedure('public.forecast_seasonal_naive_v1(uuid,date,text,integer)') is null
   or to_regprocedure('public.forecast_blend_v1(uuid,date,text,integer)') is null
   then 'MISSING: one of the competing method functions'
 when has_function_privilege('authenticated','public.forecast_run_rate_v1(uuid,date,text,integer)','EXECUTE')
   or has_function_privilege('authenticated','public.forecast_seasonal_naive_v1(uuid,date,text,integer)','EXECUTE')
   or has_function_privilege('authenticated','public.forecast_blend_v1(uuid,date,text,integer)','EXECUTE')
   then 'CRITICAL: a competing method function is callable by authenticated with any company id'
 -- The buy report filters ledger rows on horizon_months, which only exists on
 -- the view. A create-or-replace that drops it does not error -- it just makes
 -- every category read "no forward record yet", which is the exact wrong answer
 -- this column was added to prevent.
 when not exists(select 1 from information_schema.columns where table_schema='public'
   and table_name='forecast_candidate_ledger_v' and column_name='horizon_months')
   then 'CRITICAL: forecast_candidate_ledger_v has lost horizon_months; the buy report would report no forward record'
 -- A learned-nothing guard, matching the one on card split rules: the
 -- competition must never store a WEIGHT per category. Fixed weights are the
 -- specification; a fitted one is the search this whole exercise rejected.
 when exists(select 1 from information_schema.columns where table_schema='public'
   and table_name='forecast_method_selections'
   and column_name in ('weight','weights','blend_weight','tuned_parameters'))
   then 'CRITICAL: forecast_method_selections has grown a fitted weight column'
 else 'ok' end as status;

-- ── Tenant boundary: SECURITY DEFINER reachability ──────────────────────────
-- A SECURITY DEFINER function runs as its owner and therefore bypasses RLS
-- completely. Its ONLY boundary is the EXECUTE grant -- and Supabase's default
-- privileges on the `public` schema grant EXECUTE to `public` (so: anon and
-- authenticated) on every newly created function unless it is revoked
-- explicitly. That default is how `chat_run_readonly_query` ended up callable
-- by anon (20260904330000), and on 2026-09-17 an audit found three more:
-- `purge_better_reports_overlap` (deletes another tenant's sales_by_day),
-- `backfill_company_entity_batch` (stamps unclaimed rows with any company id)
-- and `attach_stamp_company_entity_id_triggers` (DDL), all confirmed callable
-- as `anon` against a company the caller had no relationship to.
--
-- The point of an ALLOWLIST rather than a list of the known-bad four: the bug
-- is a DEFAULT, so the next instance arrives by someone adding a perfectly
-- ordinary function and not thinking about grants. A denylist cannot see that
-- one; an allowlist goes red the day it lands. Adding a name here is a
-- deliberate act -- do it only once the function is safe for an
-- UNAUTHENTICATED caller, which in practice means it is a trigger function, or
-- it keys entirely off auth.uid()/active_company_id() (both NULL for anon, so
-- it returns false or no rows), or it gates itself internally.
select 'Definer functions reachable by anon' as check_name,
 case when exists (
   select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind = 'f' and p.prosecdef
     and has_function_privilege('anon', p.oid, 'EXECUTE')
     and p.proname not in (
       'ad_platforms_expected','audit_revenue_projections','can_access_entity',
       'can_approve_seo_tasks','can_manage_journal_entries',
       'check_publication_after_baselines','check_seo_measurement_window',
       'check_seo_publication_admissible',
       'current_user_can_manage_payment_requests','employees_autolink_profile',
       'ensure_entity_state','ensure_profile','forecast_candidate_may_act',
       'handle_new_user','handle_user_email_update','is_active_user',
       'is_admin_user','is_authenticated_user','is_entity_admin',
       'is_entity_member','is_owner_admin','is_owner_or_admin','next_location_id',
       'notify_slack_launch_comment','notify_slack_launch_created',
       'notify_slack_payment_request','notify_slack_sample_created',
       'notify_slack_task_created','record_product_concept_revision',
       'record_seo_task_revision','resync_tasks_on_initiative_move',
       'saved_report_usage','stamp_changed_by','stamp_company_entity_id',
       'stamp_created_by','void_card_posting'))
   then 'CRITICAL: a SECURITY DEFINER function is executable by anon and is not on the reviewed allowlist'
 else 'ok' end as status;

-- The four closed by 20260917210000, asserted individually. The allowlist check
-- above would catch an anon re-grant; this one also catches an `authenticated`
-- re-grant, which is the likelier accident (a `create or replace` restores the
-- schema default) and is still cross-tenant: none of these four takes the
-- caller's company from active_company_id(), they all take it as an argument.
select 'Service-role-only tenant primitives' as check_name,
 case
 when to_regprocedure('public.purge_better_reports_overlap(uuid)') is null
   then 'MISSING: purge_better_reports_overlap; apply 20260917210000'
 when exists (
   select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('purge_better_reports_overlap','backfill_company_entity_batch',
                       'attach_stamp_company_entity_id_triggers','refresh_demand_coverage_base_mv')
     and (has_function_privilege('anon', p.oid, 'EXECUTE')
       or has_function_privilege('authenticated', p.oid, 'EXECUTE')))
   then 'CRITICAL: a cross-tenant service-role primitive is callable from a browser session'
 -- The in-body belt. It must read the `role` GUC, NOT current_user: inside a
 -- SECURITY DEFINER function current_user is the OWNER, so a current_user guard
 -- is inert and merely looks like a control. Measured, and caught by a mutation
 -- test that re-grants EXECUTE and calls as anon/authenticated.
 when exists (
   select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('purge_better_reports_overlap','backfill_company_entity_batch')
     and pg_get_functiondef(p.oid) not like '%current_setting(''role''%')
   then 'CRITICAL: the service-role guard is missing or reads current_user (inert under SECURITY DEFINER)'
 -- A destructive function must not carry a default target.
 when exists (
   select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'purge_better_reports_overlap'
     and p.pronargdefaults > 0)
   then 'CRITICAL: purge_better_reports_overlap has a default company again'
 else 'ok' end as status;

-- No RPC may resolve an ambiguous tenant by naming one. `active_company_id()`
-- returns NULL rather than guessing, which is correct; the bug was callers
-- coalescing that NULL to Baseballism's uuid and carrying on. Membership is a
-- grant of access to a tenant's data, so "we don't know which company" has to
-- stop the call.
select 'No silent Baseballism fallback in RPCs' as check_name,
 case when exists (
   select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind = 'f'
     and p.proname in ('admin_update_profile','approve_access_request')
     and pg_get_functiondef(p.oid) like '%3bd934c9-4cdd-429b-9076-f8f6b45d4eb7%')
   then 'CRITICAL: a membership-granting RPC still defaults its company to Baseballism'
 else 'ok' end as status;

-- ── The tenant boundary must not be self-writable ──────────────────────────
-- active_company_id() is `select active_company_id from profiles where id =
-- auth.uid()`, and EVERY company-scoped policy in SILO is `company_entity_id =
-- active_company_id()`. So profiles.active_company_id is not an ordinary
-- column: it is the input the whole tenant model resolves through. Same for
-- profiles.role, which is_admin()/is_exec_or_owner() fall back to whenever
-- there is no membership row for the active company -- exactly the state a
-- forged active_company_id produces.
--
-- RLS cannot protect either one. `profiles_update_self` is `using (id =
-- auth.uid())`, which constrains WHICH ROW may be written and says nothing
-- about WHICH COLUMNS; column privileges are the only mechanism, and until
-- 20260917210000 they had never been narrowed from the schema default.
-- Measured on production 2026-09-17: one self-UPDATE took a Test Company user
-- to 1,164,910 of Baseballism's sales rows with is_admin() true.
--
-- This check is worth more than the RLS checks above it. A policy that scopes
-- rows by a column its subject can rewrite is not a boundary, and that is not
-- visible in pg_policy -- which is why the first audit of this schema passed it.
select 'Profiles privilege columns are not self-writable' as check_name,
 case
 when has_column_privilege('authenticated','public.profiles','active_company_id','UPDATE')
   then 'CRITICAL: any signed-in user can repoint their own active_company_id at another tenant'
 when has_column_privilege('authenticated','public.profiles','role','UPDATE')
   then 'CRITICAL: any signed-in user can make themselves owner'
 when has_column_privilege('authenticated','public.profiles','is_active','UPDATE')
   then 'CRITICAL: is_active is self-writable'
 when has_column_privilege('authenticated','public.profiles','department','UPDATE')
   then 'CRITICAL: department is self-writable, and finance gates read it'
 when has_column_privilege('authenticated','public.profiles','active_company_id','INSERT')
   or has_column_privilege('authenticated','public.profiles','role','INSERT')
   then 'CRITICAL: the same escalation is open on the INSERT path'
 when has_column_privilege('anon','public.profiles','name','UPDATE')
   or has_column_privilege('anon','public.profiles','name','INSERT')
   then 'CRITICAL: anon can write profiles'
 -- The other half: an over-lock silently breaks the profile page's save, and
 -- the likely response to that is `grant update on profiles`, which reopens
 -- everything above.
 when not has_column_privilege('authenticated','public.profiles','name','UPDATE')
   or not has_column_privilege('authenticated','public.profiles','default_page','UPDATE')
   or not has_column_privilege('authenticated','public.profiles','avatar_url','UPDATE')
   then 'CRITICAL: a user can no longer edit their own name/landing page/avatar; v2/profile.html save is broken'
 else 'ok' end as status;

-- ── Membership is not self-grantable ───────────────────────────────────────
-- entity_memberships is THE authorization primitive: is_admin(),
-- is_exec_or_owner(), is_entity_admin(), can_manage_journal_entries() and
-- set_active_company() all read it. `memberships_insert_self` was a PERMISSIVE
-- insert policy whose entire WITH CHECK was `(user_id = auth.uid())` -- it
-- constrained WHO the row was about and said nothing about WHICH COMPANY or
-- WHICH ROLE, and permissive policies OR, so it granted precisely what the
-- memberships_insert_admin policies beside it existed to withhold.
--
-- It is the one that DEFEATS the profiles fix rather than sitting beside it:
-- nothing is forged, the attacker inserts a real membership row and then calls
-- set_active_company(), which validates membership and duly validates against
-- the row just created. Measured on production 2026-09-18 with 20260917210000
-- applied first -- one INSERT plus one RPC gave a Test Company user 1,165,018
-- Baseballism sales rows, is_admin(), is_exec_or_owner() AND
-- can_manage_journal_entries(), the last being write access to the general
-- ledger.
--
-- Checked as a policy absence AND a grant absence: the policy drop is what
-- closes it today, the revoke is what stops a future permissive policy from
-- reopening it on its own.
select 'Membership is not self-grantable' as check_name,
 case
 when exists (select 1 from pg_policy
   where polrelid = 'public.entity_memberships'::regclass
     and polname = 'memberships_insert_self')
   then 'CRITICAL: any user can enrol themselves into any company as owner_admin'
 when exists (select 1 from pg_policy p
   where p.polrelid = 'public.entity_memberships'::regclass
     and p.polcmd = 'a' and p.polpermissive
     and coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') not like '%is_entity_admin%')
   then 'CRITICAL: a permissive INSERT policy on entity_memberships does not require entity admin'
 when has_table_privilege('authenticated', 'public.entity_memberships', 'INSERT')
   or has_table_privilege('authenticated', 'public.entity_memberships', 'UPDATE')
   or has_table_privilege('authenticated', 'public.entity_memberships', 'DELETE')
   then 'CRITICAL: a browser session can write entity_memberships'
 when has_table_privilege('anon', 'public.entity_memberships', 'INSERT')
   then 'CRITICAL: anon can write entity_memberships'
 -- The other direction: the company picker, login and profile pages all READ
 -- this table to resolve which companies a user belongs to. An over-revoke
 -- breaks sign-in, and the likely response is to restore the whole grant.
 when not has_table_privilege('authenticated', 'public.entity_memberships', 'SELECT')
   then 'CRITICAL: memberships are unreadable; the company picker and login cannot resolve a company'
 else 'ok' end as status;

-- ── Customer accounts: the onboarding form is on the open internet ─────────
-- Four properties, each of which fails silently rather than loudly.
select 'Customer account onboarding' as check_name,
 case
 when to_regclass('public.customer_accounts') is null
   then 'MISSING: customer account onboarding migration 20260919140000'
 when exists(select 1 from unnest(array['customer_accounts','customer_account_tax_profiles',
     'customer_account_addresses','customer_account_contacts','customer_account_invites',
     'customer_account_activity']) t
   where not (select relrowsecurity from pg_class where oid = to_regclass('public.'||t)))
   then 'CRITICAL: a customer account table has RLS disabled'
 -- The token table is RPC-only. A select policy on it, however well scoped,
 -- puts every live invite hash in front of every member of the company.
 when exists(select 1 from pg_policy where polrelid = 'public.customer_account_invites'::regclass)
   then 'CRITICAL: customer_account_invites has a policy; it is meant to be RPC-only'
 -- The whole reason the tax profile is a separate table: it must be NARROWER
 -- than the directory. If both gates admit the same people, the split is
 -- decoration and an EIN is one join away from a ship-to lookup.
 when not exists(select 1 from pg_policy
   where polrelid = 'public.customer_account_tax_profiles'::regclass and polcmd = 'r'
     and pg_get_expr(polqual, polrelid) like '%can_manage_client_invoices%')
   then 'CRITICAL: the customer tax profile is readable by the whole company; the EIN split is decoration'
 -- Supabase's default privileges grant EXECUTE on every new public function to
 -- anon. For a SECURITY DEFINER submission writer that is the open internet,
 -- reachable with the published anon key. 20260904330000 is the precedent.
 when exists(select 1 from unnest(array[
     'public.customer_onboarding_resolve_token(text,text)',
     'public.submit_customer_account(text,jsonb)',
     'public.claim_customer_card_setup(uuid)',
     'public.record_customer_card_setup(uuid,text,text,text,text,text,text,integer,integer,boolean)',
     'public.bind_customer_account_stripe_customer(uuid,text)']) f
   where to_regprocedure(f) is not null
     and (has_function_privilege('anon', f, 'execute')
       or has_function_privilege('authenticated', f, 'execute')))
   then 'CRITICAL: a service-role-only onboarding RPC is callable with the anon key'
 -- RLS cannot scope a policy to COLUMNS, and Supabase grants `authenticated`
 -- full DML on every new public table -- so the COLUMN privilege is what keeps
 -- a browser session out of the state machine. Without it a finance user can
 -- PATCH status straight to approved, or write the card mirror, which is a
 -- card SILO claims to hold and Stripe has never heard of.
 when exists(select 1 from unnest(array['status','approved_payment_terms','credit_limit',
     'price_tier','stripe_customer_id','card_setup_status','card_last4',
     'card_payment_method_id','default_payment_method_set_at']) c
   where has_column_privilege('authenticated', 'public.customer_accounts', c, 'update'))
   then 'CRITICAL: a customer_accounts state or card-mirror column is directly writable by authenticated'
 when has_table_privilege('authenticated', 'public.customer_accounts', 'insert')
   or has_table_privilege('authenticated', 'public.customer_accounts', 'delete')
   then 'CRITICAL: customer_accounts is client-insertable or deletable; accounts come from the invite RPC only'
 -- The other direction: revoking too much silently breaks the customer page.
 when not has_column_privilege('authenticated', 'public.customer_accounts', 'legal_name', 'update')
   then 'CRITICAL: finance cannot correct a customer name; the column grant was revoked too far'
 else 'ok' end as status;

-- The certificate is the most sensitive object SILO stores for a customer, and
-- storage policies have gone out gating on bucket_id alone before -- three
-- schedule-item-files policies shipped NAMED "by company" with no company
-- clause in any of them (20260904120000). So this asserts the EXISTS is really
-- there, and that it names the TAX PROFILE rather than the account: keyed on
-- the account it would inherit the directory's audience, which is the one
-- thing the separate table exists to prevent.
select 'Customer certificate storage scope' as check_name,
 case
 when to_regclass('public.customer_account_tax_profiles') is null
   then 'MISSING: customer account onboarding migration 20260919140000'
 when not exists(select 1 from storage.buckets where id = 'customer-account-files')
   then 'MISSING: the customer-account-files bucket'
 when (select public from storage.buckets where id = 'customer-account-files')
   then 'CRITICAL: customer-account-files is public; a seller''s permit is served with no RLS at all'
 when (select count(*) from pg_policy
   where polrelid = 'storage.objects'::regclass
     -- BOTH sides coalesced: an INSERT policy has no USING clause at all, so
     -- pg_get_expr(polqual, ...) is NULL there and an uncoalesced concatenation
     -- makes the whole comparison NULL -- which reads as "this policy is not
     -- scoped" for the one policy that governs writing the certificate.
     and coalesce(pg_get_expr(polqual, polrelid), '')
       || coalesce(pg_get_expr(polwithcheck, polrelid), '')
         like '%customer_account_tax_profiles%') < 3
   then 'CRITICAL: a customer-account-files policy does not scope through the tax profile'
 else 'ok' end as status;

-- "Same as" is a pointer, not a copy, and the chain is bounded by construction
-- so the resolving view can be two joins instead of a recursive CTE. Drop a
-- constraint and that view silently starts printing blanks or looping.
select 'Customer address pointer constraints' as check_name,
 case
 when to_regclass('public.customer_account_addresses') is null
   then 'MISSING: customer account onboarding migration 20260919140000'
 when exists(select 1 from unnest(array[
     'customer_account_addresses_business_is_root',
     'customer_account_addresses_no_self_reference',
     'customer_account_addresses_pointer_is_empty']) c
   where not exists(select 1 from pg_constraint where conname = c))
   then 'CRITICAL: an address pointer constraint is missing; a cycle or a half-filled pointer is representable'
 when to_regclass('public.customer_account_addresses_resolved_v') is null
   then 'MISSING: customer_account_addresses_resolved_v'
 else 'ok' end as status;

-- ── Workspace Settings administration (20260920120000) ────────────────────
-- Four SECURITY DEFINER functions that exist BECAUSE entity_memberships and
-- entities take no client writes. If Supabase's default privileges hand any of
-- them to anon, an unauthenticated caller reaches a definer function that
-- edits membership -- which is the authorization primitive everything else
-- reads. 20260904330000 is the precedent: a drop-and-create silently re-granted
-- anon EXECUTE on the SQL-runner RPC.
select 'Workspace membership administration' as check_name,
 case
 when (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname in ('set_workspace_member_role',
     'remove_workspace_member','set_workspace_company_name','platform_list_companies')) <> 4
   then 'MISSING: the workspace settings migration'
 when exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname in ('set_workspace_member_role',
     'remove_workspace_member','set_workspace_company_name','platform_list_companies')
     and not p.prosecdef)
   then 'CRITICAL: a workspace administration function is not SECURITY DEFINER'
 when exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname in ('set_workspace_member_role',
     'remove_workspace_member','set_workspace_company_name','platform_list_companies')
     and has_function_privilege('anon', p.oid, 'execute'))
   then 'CRITICAL: anon can execute a workspace administration function'
 -- The platform list is the one read that crosses every tenant. is_admin_user()
 -- passes for any membership admin, so it would be no gate at all here.
 when (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='platform_list_companies') not like '%is_platform_admin%'
   then 'CRITICAL: platform_list_companies is not gated by is_platform_admin()'
 -- The last-owner invariant is check-then-act across two DIFFERENT rows: the
 -- target membership is locked, the owner count is not. Without the shared
 -- per-company advisory lock, two owners each stepping back both count two
 -- owners and both commit -- measured, ZERO owners left
 -- (scripts/tests/workspace-settings-concurrency.test.mjs). Both functions
 -- must take it, and on the SAME key, or the pair is still open.
 when (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname in ('set_workspace_member_role','remove_workspace_member')
     and p.prosrc like '%silo-workspace-membership|%'
     and p.prosrc like '%pg_advisory_xact_lock%') <> 2
   then 'CRITICAL: the shared per-company owner-count lock is missing; a workspace can be left with no owner'
 -- These functions are the ONLY write path. A client grant restored on
 -- entity_memberships would make them beside the point (20260917220000).
 when has_table_privilege('authenticated', 'public.entity_memberships', 'insert')
   or has_table_privilege('authenticated', 'public.entity_memberships', 'update')
   or has_table_privilege('authenticated', 'public.entity_memberships', 'delete')
   then 'CRITICAL: authenticated can write entity_memberships directly'
 -- Renaming goes through a definer function precisely so a browser never holds
 -- entity_key or meta; an UPDATE policy on entities would hand it both.
 when has_table_privilege('authenticated', 'public.entities', 'update')
   and exists(select 1 from pg_policy where polrelid='public.entities'::regclass and polcmd in ('w','*'))
   then 'CRITICAL: entities is client-writable, so a rename can also rewrite entity_key/meta'
 else 'ok' end as status;

-- The entity admin gate must name the entity it is deciding about. Found live
-- 2026-09-20: is_owner_admin() had no entity_id predicate, so an admin of any
-- tenant read every tenant's row through can_access_entity() and could delete
-- one through entities_delete_admin_only. See 20260920160000.
select 'Entity admin gate is company-scoped' as check_name,
 case
 when not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='is_entity_admin')
   then 'MISSING: is_entity_admin'
 -- A zero-argument "am I an admin" helper cannot be scoped to a row, so its
 -- mere existence is the finding -- the next caller reopens the hole.
 when exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='is_owner_admin' and p.pronargs=0)
   then 'CRITICAL: is_owner_admin() is back; it matches every entity, not the one being acted on'
 when exists(select 1 from pg_policy
   where coalesce(pg_get_expr(polqual,polrelid),'') like '%is_owner_admin()%'
      or coalesce(pg_get_expr(polwithcheck,polrelid),'') like '%is_owner_admin()%')
   then 'CRITICAL: a policy is gated on the unscoped is_owner_admin(); policies are OR-ed, so one reopens it'
 when (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='can_access_entity') like '%is_owner_admin%'
   then 'CRITICAL: can_access_entity still ORs in the unscoped gate'
 -- Per-company roles are owner_admin|admin|member|viewer. A gate still testing
 -- role in ('owner','admin') matches NO owner_admin row and locks every owner
 -- out of their own company -- the same stale vocabulary, failing the other way.
 when (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='is_entity_admin') not like '%owner_admin%'
   then 'CRITICAL: is_entity_admin tests a stale role vocabulary and excludes every owner_admin'
 -- Founding and destroying a company are definer-function acts, not table DML.
 when has_table_privilege('authenticated', 'public.entities', 'insert')
   then 'CRITICAL: authenticated can INSERT entities, founding a tenant outside the platform-invite flow'
 when has_table_privilege('authenticated', 'public.entities', 'delete')
   then 'CRITICAL: authenticated can DELETE entities'
 else 'ok' end as status;

-- ── A SECOND claimed region, and it is not obvious ────────────────────────
-- scripts/tests/company-onboarding-database.test.mjs EXECUTES the checks
-- between the onboarding marker below and the "Plaid ingestion" marker further
-- down, and asserts there are exactly FOUR of them. So that span belongs to
-- onboarding: a check appended anywhere inside it fails that test with a bare
-- count mismatch (`7 !== 4`) that names nothing. This is the same trap the note
-- at the END of this file describes for the Plaid marker, in the other
-- direction -- the tail is claimed by the Plaid fixture, this middle is claimed
-- by the onboarding fixture, and a new check must go ABOVE this line. The
-- Stripe checks below were written between the two markers and moved here.

-- ── Stripe: billing (SILO's revenue) and Connect (the client's) ────────────
-- Three properties, each of which has a way of quietly going missing.
select 'Stripe mirror tables exist and are locked down' as check_name,
 case
 when to_regclass('public.stripe_invoices') is null
   then 'MISSING: run 20260919120000_stripe_billing_and_connect.sql'
 when exists(select 1 from (values ('billing_subscriptions'),('billing_invoices'),
     ('stripe_connect_accounts'),('stripe_invoice_customers'),('stripe_invoices'),
     ('stripe_invoice_lines'),('stripe_webhook_events'),('stripe_connect_setup_claims')) as t(name)
   where not (select relrowsecurity from pg_class where oid = to_regclass('public.'||t.name)))
   then 'CRITICAL: a Stripe table has RLS disabled'
 -- The mirror is read-only to clients BY CONSTRUCTION. A write policy here
 -- means SILO can show an invoice Stripe never issued.
 when exists(select 1 from pg_policies
   where schemaname='public'
     and tablename in ('billing_subscriptions','billing_invoices','stripe_connect_accounts',
                       'stripe_invoice_customers','stripe_invoices','stripe_invoice_lines',
                       'stripe_invoice_requests','billing_plans')
     and cmd <> 'SELECT')
   then 'CRITICAL: a client-writable policy exists on a Stripe mirror table'
 when exists(select 1 from information_schema.role_table_grants
   where table_schema='public'
     and (table_name like 'stripe\_%' or table_name like 'billing\_%')
     and grantee in ('anon','authenticated')
     and privilege_type in ('INSERT','UPDATE','DELETE'))
   then 'CRITICAL: anon or authenticated holds a write grant on a Stripe table'
 else 'ok' end as status;

-- Supabase re-grants EXECUTE to anon on every newly created public function,
-- and every one of these is SECURITY DEFINER. 20260904330000 is the precedent:
-- anon could call chat_run_readonly_query for exactly this reason.
select 'Stripe sync functions are service-role only' as check_name,
 case
 when to_regclass('public.stripe_invoices') is null then 'MISSING: Stripe migration'
 when exists(
   select 1 from unnest(array[
     'stripe_sync_invoice(uuid,text,jsonb,timestamptz)',
     'stripe_sync_subscription(uuid,jsonb,timestamptz)',
     'stripe_sync_connect_account(uuid,jsonb,timestamptz)',
     'stripe_sync_invoice_customer(uuid,text,jsonb,timestamptz)',
     'stripe_record_webhook_event(text,text,text,text,uuid,timestamptz)',
     'stripe_begin_checkout(uuid,text)',
     'stripe_begin_invoice_request(uuid,uuid,text,text,uuid,text)',
     'stripe_complete_invoice_request(uuid,text,text,text)',
     'stripe_claim_connect_setup(uuid,uuid)',
     'stripe_note_connect_setup_account(uuid,text)',
     'stripe_release_connect_setup(uuid)']) as f(sig)
   where has_function_privilege('anon', 'public.'||f.sig, 'execute')
      or has_function_privilege('authenticated', 'public.'||f.sig, 'execute'))
   then 'CRITICAL: a Stripe sync function is callable by anon or authenticated'
 else 'ok' end as status;

-- Two shapes Stripe sends that a strict reader turns into an outage.
--
-- A line whose price is metered, tiered, or added in the Stripe dashboard has
-- no inline `price.unit_amount`; the fallback field is a DECIMAL STRING, and
-- reading it strictly RAISED inside the line loop -- aborting the whole
-- invoice sync, so the webhook answered 500 and Stripe retried a legitimate
-- invoice for three days with no mirror row ever appearing. Asserted by
-- BEHAVIOUR on the exact three inputs (like normalize_merchant's check), not
-- by the function's existence, since existence never was the failure.
--
-- And `ambiguous`: the invoice-request ledger state for "Stripe may have
-- committed and we never heard". Without it, a lost answer is recorded as a
-- plain failure, the browser mints a fresh idempotency key and a real customer
-- receives a second invoice.
select 'Stripe sync accepts what Stripe actually sends' as check_name,
 case
 when to_regclass('public.stripe_invoices') is null then 'MISSING: Stripe migration'
 when to_regproc('public.stripe_decimal_cents') is null
   then 'CRITICAL: the decimal-string unit price reader is missing -- metered lines abort the sync'
 when public.stripe_decimal_cents('{"u":"20"}'::jsonb,'u') is distinct from 20::bigint
   then 'CRITICAL: a decimal STRING unit price must mirror, not raise'
 when public.stripe_decimal_cents('{"u":"150.5"}'::jsonb,'u') is not null
   then 'CRITICAL: a fractional minor unit must be null (unknown), never a rounded guess'
 when public.stripe_decimal_cents('{"u":1999}'::jsonb,'u') is distinct from 1999::bigint
   then 'CRITICAL: a plain number unit price must still be read'
 when not exists(select 1 from pg_constraint c
   where c.conrelid='public.stripe_invoice_requests'::regclass and c.contype='c'
     and pg_get_constraintdef(c.oid) like '%ambiguous%')
   then 'CRITICAL: the ledger cannot record a lost answer -- a retry would bill the customer twice'
 -- One in-flight subscription Checkout per company. Without this, the billing
 -- function's preflight is check-then-act: two requests both read "no live
 -- subscription", both create a session, and a tenant who completes both is
 -- charged twice against a mirror that can only show one subscription.
 when to_regclass('public.billing_checkout_claims') is null
   then 'CRITICAL: checkout creation is unserialized -- two requests can open two subscriptions'
 when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('stripe_claim_checkout','stripe_note_checkout_session',
                            'stripe_release_checkout','stripe_rotate_checkout_attempt')) < 4
   then 'CRITICAL: the checkout claim is missing one of its four functions'
 -- A resume that does not check WHAT the session was for hands back the old
 -- plan's URL when somebody switches plans, and charges for a plan nobody
 -- picked. The column is the only place that fact is kept.
 when not exists(select 1 from information_schema.columns
   where table_schema='public' and table_name='billing_checkout_claims'
     and column_name='plan_fingerprint')
   then 'CRITICAL: a checkout claim cannot tell which plan its session was for'
 when has_table_privilege('authenticated','public.billing_checkout_claims','select')
   then 'CRITICAL: a client can read the checkout claim table -- service role only'
 else 'ok' end as status;

-- An invoice that names one company and another company's Stripe account is
-- the single cross-tenant mistake an edge-function bug could make silently.
-- The composite FK is what makes it unrepresentable, and the staleness trigger
-- is what stops a late webhook retry reverting a paid invoice to open.
select 'Stripe tenant pairing and ordering guards' as check_name,
 case
 when to_regclass('public.stripe_invoices') is null then 'MISSING: Stripe migration'
 when not exists(select 1 from pg_constraint
   where conname='stripe_invoices_account_fk' and contype='f')
   then 'CRITICAL: an invoice can name another company''s Stripe account'
 when not exists(select 1 from pg_constraint
   where conname='stripe_invoice_customers_account_fk' and contype='f')
   then 'CRITICAL: a customer can name another company''s Stripe account'
 when (select count(*) from pg_trigger t
        where t.tgname='stripe_drop_stale_sync' and not t.tgisinternal) < 5
   then 'CRITICAL: the out-of-order webhook guard is missing from a Stripe table'
 when exists(select 1 from public.stripe_invoices i
   where not exists (select 1 from public.stripe_connect_accounts a
     where a.company_entity_id = i.company_entity_id
       and a.stripe_account_id = i.stripe_account_id))
   then 'CRITICAL: an invoice row is not paired with its company''s connected account'
 else 'ok' end as status;

-- ── Company onboarding (20260918120000) ─────────────────────────────────────
-- The gate is the trigger, not the login form: signUp is a public endpoint and
-- the anon key is published, so an org_name in the signup metadata is
-- caller-controlled input. If handle_new_user ever regains that branch,
-- founding a tenant is self-service again and nothing else here would notice.
select 'Company creation is invite-gated' as check_name,
 case
 when not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='redeem_platform_invite')
   then 'MISSING: redeem_platform_invite'
 when (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='handle_new_user') like '%org_name%insert into public.entities%'
   then 'CRITICAL: handle_new_user founds a company from signup metadata again'
 when exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='create_entity_with_owner')
   then 'CRITICAL: create_entity_with_owner is back -- a second, broken company-creation path'
 when exists(select 1 from information_schema.role_table_grants
   where table_schema='public' and table_name='platform_invites'
     and grantee in ('anon','authenticated'))
   then 'CRITICAL: platform_invites is directly reachable from the browser'
 else 'ok' end as status;

-- Founding spends this project's quota, so it is a PLATFORM act. If the gate
-- ever widens to is_admin(), 28 of 29 Baseballism profiles could mint one --
-- the same membership-'admin' blast radius that made the comp-request gate
-- diverge from the AP gate.
select 'Platform invite gate is narrow' as check_name,
 case
 when not exists(select 1 from pg_class where relname='platform_admins')
   then 'MISSING: platform_admins'
 when (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='create_platform_invite') not like '%is_platform_admin()%'
   then 'CRITICAL: create_platform_invite no longer checks is_platform_admin()'
 when (select count(*) from public.platform_admins) = 0
   then 'STALE: nobody can create a company -- platform_admins is empty'
 when exists(select 1 from information_schema.role_table_grants
   where table_schema='public' and table_name='platform_admins'
     and grantee in ('anon','authenticated') and privilege_type in ('INSERT','UPDATE','DELETE'))
   then 'CRITICAL: platform_admins is client-writable -- the gate can grant itself'
 else 'ok' end as status;

-- A stored timezone that the code does not honour reads as configured. The
-- allowlist is the one place that says which ones are real; a company settings
-- row pointing outside it means the refusal was bypassed.
select 'Business timezone is honoured, not just stored' as check_name,
 case
 when not exists(select 1 from pg_class where relname='supported_business_timezones')
   then 'MISSING: supported_business_timezones'
 when (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='silo_business_today') like '%America/Los_Angeles%'
   then 'CRITICAL: silo_business_today hardcodes Pacific again instead of reading the company'
 when exists(select 1 from public.company_settings cs
   where not exists(select 1 from public.supported_business_timezones t
                     where t.tz_name=cs.business_timezone and t.is_supported))
   then 'CRITICAL: a company is set to a timezone SILO does not honour end to end'
 else 'ok' end as status;

-- One company, one currency. accounting_settings.base_currency is MEASURED
-- from QuickBooks' trial balance; company_settings.default_currency is
-- DECLARED at onboarding. Two tables holding one fact is fine only while
-- something refuses to let them disagree.
select 'Declared and booked currency cannot diverge' as check_name,
 case
 when not exists(select 1 from pg_trigger
   where tgname='trg_accounting_currency_matches_declared' and not tgisinternal)
   then 'MISSING: the accounting_settings currency reconciliation trigger'
 when exists(select 1 from public.accounting_settings a
   join public.company_settings c on c.company_entity_id=a.company_entity_id
   where upper(a.base_currency) <> upper(c.default_currency))
   then 'CRITICAL: a company reports in one currency and books in another'
 else 'ok' end as status;

-- Plaid ingestion: metadata uses finance/company RLS; ciphertext is service-only.
with expected(name) as (values ('plaid_connections'),('plaid_connection_secrets'),
  ('plaid_accounts'),('plaid_sync_exceptions'),('finance_audit_events'))
select name as plaid_table,
  case when c.oid is null then 'MISSING — Plaid table'
    when not c.relrowsecurity then 'CRITICAL — Plaid RLS disabled'
    when not exists(select 1 from pg_attribute a where a.attrelid=c.oid and a.attname='company_entity_id' and a.attnotnull)
      then 'CRITICAL — service-owned finance records require explicit NOT NULL companies'
    when has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') then 'CRITICAL — anonymous Plaid table access'
    when name='plaid_connection_secrets' and has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE')
      then 'CRITICAL — browser credential access'
    when has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE') then 'CRITICAL — direct browser Plaid writes'
    when name<>'plaid_connection_secrets' and not has_table_privilege('authenticated',c.oid,'SELECT') then 'MISSING — Plaid metadata read grant'
    else 'ok' end as status
from expected left join pg_class c on c.oid=to_regclass('public.'||name);

with expected(signature,browser) as (values
  ('public.plaid_finance_context()',true),
  ('public.configure_plaid_account(uuid,uuid,text,date,uuid)',true),
  ('public.resolve_plaid_exception(uuid,text,uuid)',true),
  ('public.plaid_register_connection(uuid,text,text,text,jsonb,jsonb,uuid)',false),
  ('public.plaid_claim_sync(uuid,uuid)',false),
  ('public.plaid_apply_sync(uuid,uuid,text,text,jsonb,jsonb,jsonb,jsonb)',false),
  ('public.plaid_release_sync(uuid,uuid,text)',false))
select signature as plaid_rpc,
  case when p.oid is null then 'MISSING — Plaid RPC'
    when has_function_privilege('anon',p.oid,'EXECUTE') then 'CRITICAL — anonymous Plaid RPC'
    when has_function_privilege('authenticated',p.oid,'EXECUTE') is distinct from browser then 'CRITICAL — Plaid RPC authorization grant'
    when signature='public.plaid_finance_context()' and has_function_privilege('service_role',p.oid,'EXECUTE')
      then 'CRITICAL — finance context must use the caller identity'
    when signature<>'public.plaid_finance_context()' and not has_function_privilege('service_role',p.oid,'EXECUTE') then 'MISSING — Plaid service RPC grant'
    else 'ok' end as status
from expected left join pg_proc p on p.oid=to_regprocedure(signature);

with expected(relation,trigger_name) as (values
  ('public.card_sources','plaid_source_authority'),
  ('public.card_transactions','plaid_transaction_integrity'),
  ('public.card_import_batches','plaid_batch_integrity'),
  ('public.quickbooks_journal_postings','plaid_new_posting_claim'),
  ('public.finance_audit_events','finance_audit_immutable'))
select relation as plaid_guard_table,trigger_name,
  case when exists(select 1 from pg_trigger t where t.tgrelid=to_regclass(relation)
    and t.tgname=trigger_name and t.tgenabled<>'D' and not t.tgisinternal)
    then 'ok' else 'MISSING — Plaid integrity trigger' end as status
from expected;

select case when to_regclass('public.uq_plaid_transaction_identity') is null
  or to_regclass('public.uq_plaid_monthly_batch') is null
  or to_regclass('public.uq_plaid_open_exception') is null
  then 'MISSING — Plaid identity or exception uniqueness'
  when has_table_privilege('service_role','public.finance_audit_events','INSERT,UPDATE,DELETE,TRUNCATE')
  then 'CRITICAL — direct service audit mutation'
  else 'ok' end as plaid_identity_and_audit_contract;

-- Bank workspace: unknown historical request is NULL, never a guessed default.
select case when exists(select 1 from information_schema.columns
  where table_schema='public' and table_name='plaid_connections'
    and column_name='history_days_requested' and data_type='integer'
    and is_nullable='YES' and column_default is null)
  then 'ok' else 'MISSING — apply bank_feed_workspace_history after review' end as status;

-- Accounting foundation: local opening history and least-privilege onboarding.
select 'Accounting foundation tables' as check_name,
 case when count(*)=3 and bool_and(c.relrowsecurity) then 'ok' else 'MISSING: accounting foundation migration / RLS' end as status
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
 and c.relname in ('accounting_settings','accounting_accounts','accounting_opening_balances');
select 'Accounting foundation client grants' as check_name,
 case when count(*)=3 and bool_and(not has_table_privilege('anon',c.oid,'SELECT')
 and not has_table_privilege('authenticated',c.oid,'INSERT')
 and not has_table_privilege('authenticated',c.oid,'UPDATE')
 and not has_table_privilege('authenticated',c.oid,'DELETE')
 and has_table_privilege('authenticated',c.oid,'SELECT')) then 'ok' else 'MISSING: RPC-only accounting writes' end as status
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
 and c.relname in ('accounting_settings','accounting_accounts','accounting_opening_balances');
select 'Accounting onboarding RPC grants' as check_name,
 case when count(*)=3 and bool_and(not has_function_privilege('anon',p.oid,'EXECUTE')
 and has_function_privilege('authenticated',p.oid,'EXECUTE') and p.prosecdef) then 'ok'
 else 'MISSING: accounting RPC authorization' end as status
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
 and p.proname in ('seed_accounting_from_qbo','accept_accounting_opening_balances','accounting_qbo_connections');
select 'Accounting register invoker' as check_name,
 case when exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relname='accounting_journal_register' and c.reloptions @> array['security_invoker=true'])
 then 'ok' else 'MISSING: accounting register invoker view' end as status;

-- QBO historical ledger: retained evidence, no journal posting destination.
with expected(name) as (values ('qbo_history_imports'),('qbo_history_lines'))
select name as history_table,case when c.oid is null then 'MISSING: QBO history migration'
 when not c.relrowsecurity then 'CRITICAL: historical ledger RLS disabled'
 when has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
 or has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE')
 or not has_table_privilege('authenticated',c.oid,'SELECT') then 'CRITICAL: historical ledger client grants'
 when not exists(select 1 from pg_policy p where p.polrelid=c.oid and p.polname='history_finance_read'
 and pg_get_expr(p.polqual,p.polrelid) like '%active_company_id()%'
 and pg_get_expr(p.polqual,p.polrelid) like '%can_manage_journal_entries()%'
 and pg_get_expr(p.polqual,p.polrelid) like '%is_exec_or_owner()%') then 'CRITICAL: historical ledger finance/company policy'
 when not exists(select 1 from pg_trigger t where t.tgrelid=c.oid and t.tgname='history_immutable'
 and t.tgenabled<>'D' and (t.tgtype::integer & 58)=58
 and t.tgfoid=to_regprocedure('public.finance_deny_audit_mutation()')) then 'CRITICAL: historical ledger immutability'
 else 'ok' end as status from expected left join pg_class c on c.oid=to_regclass('public.'||name);
select 'QBO history import RPC' as check_name,
 case when p.oid is null then 'MISSING: archive_qbo_ledger'
 when not p.prosecdef or has_function_privilege('anon',p.oid,'EXECUTE')
 or not has_function_privilege('authenticated',p.oid,'EXECUTE') then 'CRITICAL: archive RPC grants'
 else 'ok' end as status from (select to_regprocedure('public.archive_qbo_ledger(uuid,uuid)') oid) x left join pg_proc p on p.oid=x.oid;
select 'QBO history number formats' as check_name,
 case when to_regprocedure('public.qbo_report_number(text,text)') is null then 'MISSING: QBO history number-format migration (20260914220000)'
 when has_function_privilege('anon',to_regprocedure('public.qbo_report_number(text,text)'),'EXECUTE')
 or has_function_privilege('authenticated',to_regprocedure('public.qbo_report_number(text,text)'),'EXECUTE') then 'CRITICAL: number parser client grants'
 when to_regprocedure('public.archive_qbo_ledger(uuid,uuid)') is null then 'MISSING: archive_qbo_ledger'
 when pg_get_functiondef(to_regprocedure('public.archive_qbo_ledger(uuid,uuid)')) not like '%qbo_report_number(%'
 or pg_get_functiondef(to_regprocedure('public.archive_qbo_ledger(uuid,uuid)')) like '%''Invalid ledger movement''%'
 or not exists(select 1 from pg_constraint where conrelid=to_regclass('public.qbo_history_lines') and conname='qbo_history_lines_row_kind_check'
 and pg_get_constraintdef(oid) like '%zero_amount%')
 or not exists(select 1 from pg_constraint where conrelid=to_regclass('public.qbo_history_lines') and conname='qbo_history_lines_transaction_nonzero')
 then 'STALE: archive_qbo_ledger still rejects leading-decimal QBO amounts or zero lines are not their own row kind; apply 20260914220000'
 else 'ok' end as status;
select 'QBO history retention and audit' as check_name,
 case when to_regclass('public.qbo_history_imports') is null then 'MISSING: QBO history migration'
 when exists(select 1 from pg_constraint where conrelid=to_regclass('public.qbo_history_imports') and contype='f'
 and confrelid in (to_regclass('public.quickbooks_connections'),to_regclass('public.quickbooks_report_runs')))
 then 'CRITICAL: archive depends on live connection or report cache'
 when not exists(select 1 from pg_trigger where tgrelid=to_regclass('public.qbo_history_imports') and tgname='finance_audit_event' and tgenabled<>'D')
 then 'CRITICAL: history import audit missing' else 'ok' end as status;
-- Bounded archive (20260915000000). The single-call RPC appended every line
-- to one jsonb value -- quadratic, measured at ~27 minutes for the 36,778-row
-- production report against PostgREST's 8s ceiling, which a function-level
-- statement_timeout cannot raise (the timer is armed before the function's
-- SET applies; measured on PostgreSQL 16). The job/staging tables and the
-- resumable RPC are what keep every call under the ceiling.
select 'QBO history bounded archive' as check_name,
 case when to_regclass('public.qbo_history_jobs') is null or to_regclass('public.qbo_history_staging_sections') is null
   or to_regclass('public.qbo_history_staging_lines') is null then 'MISSING: QBO history bounded-archive migration (20260915000000)'
 when (select count(*) from pg_class where relrowsecurity and oid in (to_regclass('public.qbo_history_jobs'),to_regclass('public.qbo_history_staging_sections'),to_regclass('public.qbo_history_staging_lines')))<>3
  then 'CRITICAL: archive job or staging table has RLS disabled'
 when has_table_privilege('authenticated',to_regclass('public.qbo_history_jobs'),'INSERT,UPDATE,DELETE,TRUNCATE')
  or has_table_privilege('anon',to_regclass('public.qbo_history_jobs'),'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
  or not has_table_privilege('authenticated',to_regclass('public.qbo_history_jobs'),'SELECT')
  or has_table_privilege('authenticated',to_regclass('public.qbo_history_staging_sections'),'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
  or has_table_privilege('authenticated',to_regclass('public.qbo_history_staging_lines'),'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
  or has_table_privilege('anon',to_regclass('public.qbo_history_staging_sections'),'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
  or has_table_privilege('anon',to_regclass('public.qbo_history_staging_lines'),'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
  then 'CRITICAL: archive job/staging client grants (jobs are finance-readable only; staging is closed to every client)'
 when not exists(select 1 from pg_policy p where p.polrelid=to_regclass('public.qbo_history_jobs') and p.polname='history_jobs_finance_read'
  and pg_get_expr(p.polqual,p.polrelid) like '%active_company_id()%' and pg_get_expr(p.polqual,p.polrelid) like '%can_manage_journal_entries()%')
  then 'CRITICAL: archive job progress is not scoped to the finance users of the company'
 when not exists(select 1 from pg_indexes where schemaname='public' and tablename='qbo_history_jobs' and indexname='qbo_history_jobs_one_running')
  then 'CRITICAL: two running jobs for one source are not prevented'
 when to_regprocedure('public.archive_qbo_ledger(uuid,uuid)') is null then 'MISSING: archive_qbo_ledger'
 when pg_get_functiondef(to_regprocedure('public.archive_qbo_ledger(uuid,uuid)')) not like '%qbo_history_staging_lines%'
  or pg_get_functiondef(to_regprocedure('public.archive_qbo_ledger(uuid,uuid)')) like '%staged:=staged||%'
  then 'STALE: archive_qbo_ledger still accumulates every line in one jsonb value (quadratic; times out past ~2,500 rows); apply 20260915000000'
 when exists(select 1 from pg_proc p, unnest(p.proconfig) c where p.oid=to_regprocedure('public.archive_qbo_ledger(uuid,uuid)') and c like 'statement_timeout=%')
  then 'STALE: archive_qbo_ledger carries a statement_timeout setting that PostgREST does not honour for the calling statement; remove it (see 20260915000000)'
 -- Setup and finalization are not row-bounded and grow with the report
 -- (measured: longest call 3.6s at 100k rows, 6.9s at 150k, against 8s).
 -- Without the size guard the bound is a claim rather than a fact. BOTH
 -- ceilings are required: rows for a sparse ledger, bytes for a dense one
 -- (hashing measured 1.21s at 7.7MB and 7.10s at 15.5MB, so the byte ceiling
 -- is what keeps the hash inside the timeout).
 when pg_get_functiondef(to_regprocedure('public.archive_qbo_ledger(uuid,uuid)')) not like '%qbo_archive_max_rows%'
  or pg_get_functiondef(to_regprocedure('public.archive_qbo_ledger(uuid,uuid)')) not like '%qbo_archive_max_bytes%'
  or pg_get_functiondef(to_regprocedure('public.archive_qbo_ledger(uuid,uuid)')) not like '%pg_column_size(gl.raw_response)%'
  then 'STALE: archive_qbo_ledger lost the report-size guard; its unbounded setup and final copy can cross the statement timeout on a large report'
 -- ORDER, not just presence. Hashing the snapshot is the largest piece of the
 -- unbounded setup, so a ceiling standing after it guards nothing: the
 -- oversized report would be copied and sha256'd in full and only then
 -- refused. Compares first occurrences in the stored body, and matches the
 -- CALL SITE rather than the bare helper name, which also appears in the
 -- comment above the guard.
 when strpos(pg_get_functiondef(to_regprocedure('public.archive_qbo_ledger(uuid,uuid)')),'pg_column_size(gl.raw_response)')
    > strpos(pg_get_functiondef(to_regprocedure('public.archive_qbo_ledger(uuid,uuid)')),'digest:=public.finance_approval_snapshot_hash')
  then 'CRITICAL: archive_qbo_ledger hashes the source snapshot before checking the report size, so the ceiling does not bound the setup work it exists to bound'
 -- Finalization must record a terminal failure rather than leaving the job
 -- 'running' with every resume repeating the same error.
 when (length(pg_get_functiondef(to_regprocedure('public.archive_qbo_ledger(uuid,uuid)')))
   - length(replace(pg_get_functiondef(to_regprocedure('public.archive_qbo_ledger(uuid,uuid)')),'exception when others then',''))) / length('exception when others then') < 2
  then 'STALE: archive_qbo_ledger finalization is not inside its own exception block; a final-copy error would strand the job as running'
 when not exists(select 1 from pg_trigger where tgrelid=to_regclass('public.qbo_history_imports') and tgname='finance_audit_event' and tgenabled<>'D'
  and tgfoid=to_regprocedure('public.qbo_history_audit_event()'))
  then 'STALE: the import audit event still copies the multi-megabyte source snapshot into finance_audit_events; apply 20260915000000'
 -- QBO emits one account-less housekeeping section ('Not Specified'); the
 -- archive keeps its rows under a placeholder that cannot be read as a real
 -- account, and still refuses the import outright if such a section carries
 -- money. Losing either half is a different failure: the first makes the
 -- full-year window unarchivable again, the second files real money under a
 -- placeholder.
 when pg_get_functiondef(to_regprocedure('public.archive_qbo_ledger(uuid,uuid)')) not like '%silo:unattributed%'
  then 'STALE: an account-less ledger section refuses the whole import again, so QBO''s own Not Specified bucket blocks the archive; apply 20260915200000'
 when pg_get_functiondef(to_regprocedure('public.archive_qbo_ledger(uuid,uuid)')) not like '%has no QuickBooks account and carries%'
  then 'CRITICAL: an account-less ledger section carrying money would be archived under the unattributed placeholder instead of refusing'
 -- The placeholder skips the trial-balance comparison, so its admission test
 -- is the only thing between a real balance and an archive reading 'matched'.
 -- Amounts alone are not enough: a Beginning Balance row with a blank amount
 -- and a real running balance passes an amounts-only test and keeps that
 -- balance under the placeholder forever.
 when pg_get_functiondef(to_regprocedure('public.archive_qbo_ledger(uuid,uuid)')) not like '%has no QuickBooks account and carries a running balance%'
  then 'CRITICAL: an account-less ledger section carrying a running balance would be archived under the unattributed placeholder instead of refusing'
 -- A blank running balance on the placeholder reads as zero (four of seven
 -- stored windows carry such a row); losing this refuses those windows again.
 when pg_get_functiondef(to_regprocedure('public.archive_qbo_ledger(uuid,uuid)')) not like '%then row_balance:=0%'
  then 'STALE: a blank running balance on the unattributed section refuses the import again; apply 20260915200000'
 -- Summary column 7 is the section's ENDING BALANCE, a separate claim from the
 -- period total in column 6: zero movement and a balance carried out is a
 -- coherent report. A real account would catch it as a trial_balance_mismatch;
 -- the placeholder skips that comparison, so nothing else would look at it.
 when pg_get_functiondef(to_regprocedure('public.archive_qbo_ledger(uuid,uuid)')) not like '%has no QuickBooks account and reports a non-zero ending balance%'
  then 'CRITICAL: an account-less ledger section reporting a balance carried out would be archived under the unattributed placeholder and read as matched'
 -- A trial balance over a DIFFERENT PERIOD than the ledger is a valid report
 -- answering a different question: balance-sheet accounts report as-at, so they
 -- tie either way, but income and expense accounts report activity for the
 -- range. Without this the page's fiscal-year-start request turned a twelve
 -- month ledger against a seven month trial balance into 63 P&L mismatches
 -- worth $33.3m (2026-09-15) that looked like lost history and were not.
 when pg_get_functiondef(to_regprocedure('public.archive_qbo_ledger(uuid,uuid)')) not like '%tb.start_date is distinct from gl.start_date%'
  then 'CRITICAL: a trial balance covering a different period than the ledger is accepted, so every P&L account reconciles against the wrong figure'
 when pg_get_functiondef(to_regprocedure('public.archive_qbo_ledger(uuid,uuid)')) not like '%Header,StartPeriod%'
  then 'CRITICAL: neither report''s declared StartPeriod is checked, so QBO answering for a different range than it was asked passes unnoticed'
 -- The exemption from exception_count is the NOTICE, never the section. A
 -- blanket exemption hides a running balance gap or a period total mismatch
 -- on that section behind an archive that still reads 'matched'.
 when pg_get_functiondef(to_regprocedure('public.archive_qbo_ledger(uuid,uuid)')) not like '%p<>''unattributed_ledger_section''%'
  then 'CRITICAL: every reconciliation problem on the unattributed section is exempt from exception_count, so a real mismatch there still reports matched'
 else 'ok' end as status;

-- Card transaction splits (20260915100000). One coded row carried one account
-- and posted one journal line, so a loan payment's principal and interest could
-- not both be recorded. Splits must total their transaction to the cent: the
-- settlement side of the entry is computed from the batch total, so a split
-- that did not tie would unbalance the entry or move money the statement never
-- moved. The posting snapshot reads card_coding_effective_lines so a split line
-- passes the same account, location and entity checks an ordinary line does.
select 'Card transaction splits' as check_name,
 case when to_regclass('public.card_transaction_splits') is null or to_regclass('public.card_split_rules') is null
   or to_regclass('public.card_split_rule_lines') is null or to_regclass('public.card_coding_effective_lines') is null
  then 'MISSING: card split migration (20260915100000)'
 when (select count(*) from pg_class where relrowsecurity and oid in (to_regclass('public.card_transaction_splits'),
   to_regclass('public.card_split_rules'), to_regclass('public.card_split_rule_lines'))) <> 3
  then 'CRITICAL: a card split table has RLS disabled'
 when has_table_privilege('authenticated', to_regclass('public.card_transaction_splits'), 'INSERT,UPDATE,DELETE,TRUNCATE')
   or has_table_privilege('anon', to_regclass('public.card_transaction_splits'), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
   or has_table_privilege('authenticated', to_regclass('public.card_split_rules'), 'INSERT,UPDATE,DELETE,TRUNCATE')
   or has_table_privilege('authenticated', to_regclass('public.card_split_rule_lines'), 'INSERT,UPDATE,DELETE,TRUNCATE')
  then 'CRITICAL: card splits are client-writable; they may only be written through set_card_transaction_splits'
 when not exists (select 1 from pg_trigger where tgname = 'card_splits_must_tie'
   and tgrelid = to_regclass('public.card_transaction_splits') and tgenabled <> 'D' and tgdeferrable)
  then 'CRITICAL: the deferred tie-out constraint on card splits is missing; an unbalanced split could post'
 when not exists (select 1 from pg_trigger where tgname = 'card_transaction_splits_still_tie'
   and tgrelid = to_regclass('public.card_transactions') and tgenabled <> 'D')
  then 'CRITICAL: a split transaction can be re-coded to one account or have its amount moved'
 when to_regprocedure('public.set_card_transaction_splits(uuid,jsonb,boolean,text)') is null
   or has_function_privilege('anon', to_regprocedure('public.set_card_transaction_splits(uuid,jsonb,boolean,text)'), 'EXECUTE')
  then 'CRITICAL: the split write path is missing or reachable by anon'
 -- A learned split rule stores accounts, never amounts: an amortizing payment
 -- divides differently every month and a remembered figure would look
 -- authoritative while being wrong.
 when exists (select 1 from information_schema.columns where table_schema = 'public'
   and table_name in ('card_split_rules','card_split_rule_lines')
   and (column_name like '%amount%' or column_name like '%proportion%' or column_name like '%percent%'))
  then 'CRITICAL: a split rule can store an amount; only the shape may be learned'
 when pg_get_functiondef(to_regprocedure('public.approve_card_import_batch(uuid)')) not like '%card_coding_effective_lines%'
  then 'STALE: the approval snapshot no longer reads card_coding_effective_lines, so split lines post unvalidated or not at all; apply 20260915100000'
 -- The bank feed's own approval guard judges clearing-account treatment per
 -- POSTED LINE. Back on the parent's account column it silently skips every
 -- split row, so a card payment could be split into expense accounts and
 -- approved where the same row unsplit is refused.
 when to_regprocedure('public.plaid_guard_batch()') is not null
   and pg_get_functiondef(to_regprocedure('public.plaid_guard_batch()')) not like '%card_coding_effective_lines%'
  then 'CRITICAL: the bank feed approval guard judges treatment through the parent account only, so split rows skip its direction and clearing-account checks'
 -- A provider amount correction on a DRAFT split row must drop the split with
 -- the rest of its coding. Without it the tie check raises inside
 -- plaid_apply_sync, which rolls back the cursor too, so that account's feed
 -- stops for good.
 when not exists (select 1 from pg_trigger where tgname = 'card_splits_follow_provider_change'
   and tgrelid = to_regclass('public.card_transactions') and tgenabled <> 'D')
  then 'CRITICAL: a bank correction to a split transaction would fail its sync and wedge that account''s cursor'
 -- A memo the person typed and read back in the preview must be the memo that
 -- posts, not "split 2".
 when pg_get_functiondef(to_regprocedure('public.approve_card_import_batch(uuid)')) not like '%nullif(e.memo%'
  then 'STALE: the approved payload drops split memos the preview showed; apply 20260915100000'
 else 'ok' end as status;

-- Profiles tenant isolation. Policies are OR'd, so one unscoped SELECT policy
-- re-opens the cross-tenant leak that put Baseballism people in Test Company's
-- assignee dropdowns. Assert the count, not just the presence.
select 'Profiles active-company scope' as check_name,
 case when to_regprocedure('public.shares_active_company(uuid)') is null then 'MISSING: shares_active_company helper'
 when (select count(*) from pg_policy where polrelid='public.profiles'::regclass and polcmd='r') <> 1
   then 'CRITICAL: profiles has more than one SELECT policy; an unscoped one re-opens the tenant leak'
 when not exists(select 1 from pg_policy where polrelid='public.profiles'::regclass and polcmd='r'
   and pg_get_expr(polqual,polrelid) like '%shares_active_company%')
   then 'CRITICAL: profiles SELECT policy is not company-scoped'
 when exists(select 1 from pg_policy where polrelid='public.profiles'::regclass and polcmd='w'
   and pg_get_expr(polqual,polrelid) like '%is_owner_admin%')
   then 'CRITICAL: profiles UPDATE policy admits any-tenant owner/admin'
 else 'ok' end as status;

select 'Cashflow override controls' as check_name,
 case when to_regclass('public.cash_forecast_overrides') is null then 'MISSING: cashflow override migration'
 when not (select relrowsecurity from pg_class where oid=to_regclass('public.cash_forecast_overrides')) then 'CRITICAL: cashflow override RLS disabled'
 when not exists(select 1 from pg_constraint where conrelid=to_regclass('public.cash_forecast_overrides') and conname='cash_override_no_overlap') then 'CRITICAL: override overlap guard missing'
 when not exists(select 1 from pg_trigger where tgrelid=to_regclass('public.cash_forecast_overrides') and tgname='finance_audit_event' and tgenabled<>'D') then 'CRITICAL: override audit missing'
 else 'ok' end as status;

select 'Plaid removal classification' as check_name,
 case when to_regclass('public.card_transactions') is null then 'MISSING: card coding migration'
 when not exists(select 1 from information_schema.columns where table_schema='public'
   and table_name='card_transactions' and column_name='removed_from_status')
   then 'MISSING: removed_from_status migration'
 when not exists(select 1 from pg_constraint
   where conname='card_transactions_removed_from_status_check')
   then 'CRITICAL: removed_from_status accepts values other than pending/posted'
 -- The projection must RECORD it, not leave the UI inferring it from a payload.
 when (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='plaid_project_transaction') not like '%removed_from_status=v_removed_from%'
   then 'CRITICAL: plaid_project_transaction does not stamp removed_from_status'
 -- A removed row with no classification reads as a retracted posting, so an
 -- unbackfilled row would put the feed's own bookkeeping in front of a person.
 when exists(select 1 from public.card_transactions
   where origin='plaid' and provider_status='removed' and removed_from_status is null)
   then 'STALE: removed Plaid rows are unclassified; re-run the 20260915220000 backfill'
 else 'ok' end as status;

-- ── Appending a check below this line has a second obligation ──────────────
-- Everything after the "Plaid ingestion" marker above is executed by
-- scripts/tests/plaid-bank-feed-database.test.mjs against ITS fixture, which
-- builds only the finance/Plaid schema. A check appended at the end of this
-- file therefore fails that job unless the migration it tests is added to the
-- `later` list in that test. #684 and #686 both did this and turned the
-- finance-database job red on every push to main; a third instance landed in
-- the Meta destination work, which is why this note now exists in the file the
-- check gets appended to rather than only in the test that breaks.
--
-- So: put a check for anything OUTSIDE the finance/Plaid schema above the
-- Plaid marker, and only add to the tail when the fixture genuinely covers it.
