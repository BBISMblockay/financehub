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
from (values ('profiles_select_own'), ('profiles_update_own')) as want(polname)
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

select
  count(*)::int as stamped_tables,
  case
    when count(*) >= (
      select count(*) - 2
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'public'
        and c.column_name = 'company_entity_id'
        and t.table_type = 'BASE TABLE'
    ) then 'ok'
    else 'MISSING — run attach_stamp_company_entity_id_triggers()'
  end as status
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and t.tgname = 'stamp_company_entity_id'
  and not t.tgisinternal;

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
  case when exists (select 1 from pg_indexes where schemaname='public' and indexname='uq_quickbooks_postings_source_ref_posted') then 'ok' else 'MISSING' end as posting_double_post_guard;

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
     and exists (
        select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'admin_update_profile'
          and pg_get_functiondef(p.oid) ilike '%Cross-tenant guard%')
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
    when not exists (
      select 1 from pg_proc p join pg_language l on l.oid = p.prolang
      where p.proname = 'notify_sample_events' and l.lanname = 'plpgsql'
        and pg_get_functiondef(p.oid) ilike '%SAMPLE_ASSIGNED%'
    )
      then 'MISSING — notify_sample_events() not updated with SAMPLE_REQUESTED/WAREHOUSE_READY/ASSIGNED'
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
select
  case
    when not exists (
      select 1 from pg_proc p join pg_language l on l.oid = p.prolang
      where p.proname = 'notify_sample_events' and l.lanname = 'plpgsql'
        and pg_get_functiondef(p.oid) ilike '%old.sample_status is distinct from new.sample_status%'
    )
      then 'MISSING — run 20260818200000_sample_received_transition_within_family.sql'
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
                       and pg_get_functiondef(p.oid) like '%limit 500%')
      then 'MISSING — the 500-row cap was dropped'
    else 'ok'
  end as chat_query_timeout;

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

-- ── Product-title sales rollup (20260826230000) ───────────────────────
select
  case
    when not exists (select 1 from information_schema.views
                     where table_schema='public' and table_name='sales_by_product_title_daily_v')
      then 'MISSING — run 20260826230000_sales_by_product_title_daily.sql'
    when not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
                     where n.nspname='public' and c.relname='sales_by_product_title_daily_v'
                       and c.reloptions::text like '%security_invoker=true%')
      then 'MISSING — sales_by_product_title_daily_v is not security_invoker; RLS would stop scoping it to the active company'
    when not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='sales_by_product_title_daily_v'
                       and column_name='title_source')
      then 'MISSING — title_source dropped; unmatched SKUs would become indistinguishable from resolved ones'
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
                        and policyname='card_transactions_write'
                        and qual like '%status <> ''posted''%')
      then 'MISSING — card_transactions_write no longer blocks edits to a posted batch'
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
