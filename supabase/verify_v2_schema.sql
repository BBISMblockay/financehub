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

-- 7b. Supermetrics integration tables (20260716000000_supermetrics_kpis.sql)
select
  case when exists (select 1 from information_schema.tables where table_schema='public' and table_name='supermetrics_connections') then 'ok' else 'MISSING' end as supermetrics_connections,
  case when exists (select 1 from information_schema.tables where table_schema='public' and table_name='marketing_kpis_daily') then 'ok' else 'MISSING' end as marketing_kpis_daily,
  case when exists (select 1 from pg_constraint where conname='sync_jobs_job_type_check' and pg_get_constraintdef(oid) like '%supermetrics_kpis%') then 'ok' else 'MISSING' end as sync_jobs_supermetrics_type;

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

select
  case
    when exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = 'silo_insights_digest'
    ) and exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'compute_silo_insights'
    ) and not has_function_privilege('authenticated', 'public.compute_silo_insights(uuid)', 'EXECUTE')
    then 'ok'
    else 'MISSING — run 20260709050000_silo_insights_engine.sql'
  end as silo_insights_engine;

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

-- 13. Quick counts (0 is fine on a fresh install)
select
  (select count(*) from public.factories)            as factories,
  (select count(*) from public.po_headers)           as po_headers,
  (select count(*) from public.po_costing)           as po_costing,
  (select count(*) from public.profiles)             as profiles,
  (select count(*) from public.launch_calendar)      as launches,
  (select count(*) from public.shopify_connections)  as shopify_connections;
