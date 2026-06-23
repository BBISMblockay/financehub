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
  case when pol.polname is not null then 'ok' else 'MISSING — run section 3 in apply_all_post_merge.sql' end as status
from (values ('profiles_select_own'), ('profiles_update_own')) as want(polname)
left join pg_policies pol
  on pol.schemaname = 'public'
 and pol.tablename = 'profiles'
 and pol.polname = want.polname;

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

-- 8. Quick counts (0 is fine on a fresh install)
select
  (select count(*) from public.factories)            as factories,
  (select count(*) from public.po_headers)           as po_headers,
  (select count(*) from public.po_costing)           as po_costing,
  (select count(*) from public.profiles)             as profiles,
  (select count(*) from public.launch_calendar)      as launches,
  (select count(*) from public.shopify_connections)  as shopify_connections;
