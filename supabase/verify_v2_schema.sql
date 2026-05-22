-- =============================================================================
-- SILO schema check (run in Supabase SQL Editor after migrations)
-- All "ok" rows should show status = 'ok'. Anything "missing" needs apply SQL.
-- =============================================================================

with expected as (
  select * from (values
    ('table',  'factories'),
    ('table',  'po_headers'),
    ('table',  'po_lines'),
    ('table',  'po_costing'),
    ('table',  'po_costing_lines'),
    ('view',   'v_po_header_summary'),
    ('view',   'v_po_costing_summary'),
    ('view',   'v_po_sku_prior_cost'),
    ('routine','generate_next_po_name')
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
  select 'routine', p.proname
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
)
select
  e.kind,
  e.name,
  case when f.name is not null then 'ok' else 'MISSING — run supabase/apply_all_post_merge.sql' end as status
from expected e
left join found f on f.kind = e.kind and f.name = e.name
order by e.kind, e.name;

-- Profile policies (needed for /v2/profile.html)
select
  want.polname as policy_name,
  case when pol.polname is not null then 'ok' else 'MISSING — run section 3 in apply_all_post_merge.sql' end as status
from (values ('profiles_select_own'), ('profiles_update_own')) as want(polname)
left join pg_policies pol
  on pol.schemaname = 'public'
 and pol.tablename = 'profiles'
 and pol.polname = want.polname;

-- Quick counts (0 is fine on a fresh install)
select
  (select count(*) from public.factories) as factories,
  (select count(*) from public.po_headers) as po_headers,
  (select count(*) from public.po_costing) as po_costing;
