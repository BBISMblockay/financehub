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

-- 9. Quick counts (0 is fine on a fresh install)
select
  (select count(*) from public.factories)            as factories,
  (select count(*) from public.po_headers)           as po_headers,
  (select count(*) from public.po_costing)           as po_costing,
  (select count(*) from public.profiles)             as profiles,
  (select count(*) from public.launch_calendar)      as launches,
  (select count(*) from public.shopify_connections)  as shopify_connections;
