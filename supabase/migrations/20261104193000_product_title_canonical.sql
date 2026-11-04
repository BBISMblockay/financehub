-- One product, one title: stop a non-storefront catalog renaming a product in
-- every report.
--
-- WHAT WAS WRONG. sales_by_product_title_daily_mv resolved its title with
--
--     coalesce(pm.product_title, s.product_name)
--     ... left join products_master pm on pm.sku = s.sku
--
-- and products_master is UNIQUE (company_entity_id, sku) while runCatalogSync
-- runs ONCE PER SHOP CONNECTION. For any SKU carried by more than one store
-- the stored title is therefore whichever store synced LAST, and the order is
-- alphabetical by shop_domain (scripts/shopify-sync.mjs loadConnections()
-- `.order('shop_domain')`) -- which is not a statement about anything.
-- shopify-sync-core.mjs says so itself where it builds the per-shop variant
-- map: products_master "cannot in any case represent the same SKU being a
-- different product in another store -- measured at 26.9% of SKUs that have
-- ever sold".
--
-- Measured on production 2026-11-04. Baseballism's "Short Sleeve Youth Hoodie
-- - New York Yankees" (online product 7779394519110) is one product with four
-- youth sizes. Three of the four SKUs are also in the wholesale catalog, whose
-- draft product 14662555697519 spells it "Short Sleeve Hoodie Youth - New York
-- Yankees" (word order swapped), and wholesale sorts after the storefront, so
-- those three SKUs carried the wholesale wording. Every title-grouped report
-- then split one product in two: for 2025-11-19..2025-12-01, online, an
-- exact-title read returned 151 units / $5,796 gross, where the product
-- actually sold 430 units / $17,166 gross / $17,430.24 total sales. Both
-- numbers were "right" against their own query, which is the whole problem --
-- it is not a Shopify catalog duplicate, and there is nothing to merge in
-- Shopify. The order lines themselves never disagreed: all four SKUs were sold
-- under the storefront title in that window.
--
-- Scale, same measurement, sales since 2025-11-01: 1,901 SKUs that have sold
-- carry a products_master title the selling store does not use; 56 of 8,081
-- store-products were split across two or more titles.
--
-- THE FIX. Resolve the title per (company, sku) from the per-shop catalog map
-- shopify_product_skus -- which exists precisely because products_master
-- collapses a SKU across stores -- and prefer the store copy that is actually
-- published:
--
--     active before draft/archived, then published-at present, then most
--     recently seen, then shop_domain, then product id
--
-- Deliberately a title per SKU rather than per selling store. Resolving
-- per-store would be more "literal" and makes the within-store splitting
-- worse, not better: 796 SKUs that sold since 2025-11-01 are carried by two
-- stores that name them differently, so a company-wide "top products" read
-- would split 796 products to un-split 56. One canonical title per SKU keeps
-- every cross-store rollup whole.
--
-- No tenant-specific signal is used -- no shop name, no default_location_code
-- (free text, and set per-store by migration for one company). "Published in
-- Shopify" is a property every tenant's catalog carries. Measured effect on
-- Baseballism: store-products split across titles 56 -> 15; the residual 15
-- are products whose own SKUs are published in two stores that genuinely
-- disagree on the name, which no rule keyed on a single SKU can collapse.
-- products_master stays the fallback (8,361 of 562,520 sales rows since
-- 2025-11-01 resolve only through it) and sales_by_day.product_name stays the
-- last resort, still counted, never dropped -- same as before.
--
-- NOT CHANGED, on purpose: the select list, column order, column names, grain,
-- the two title_source values, the unique index, the day index, the grants,
-- the refresh function, and products_master itself. Callers -- six saved
-- reports, four tie-outs, the report-builder start-here list, Ask SILO's
-- schema catalog, product_type_profile and the SEO candidate function -- are
-- untouched. product_type still comes from products_master: shopify_product_skus
-- does not carry one.
--
-- HOW THIS IS APPLIED. A matview cannot be redefined in place, and two views
-- read this one (sales_by_product_title_daily_v, product_type_forecastable_v),
-- so the new rollup is BUILT FIRST under a temporary name and verified while
-- the live one still serves reads; the swap is then a drop + rename inside one
-- transaction, which is the only moment a read can fail. Both views are
-- recreated from their live definitions, character for character apart from
-- the comment.

set statement_timeout = '900s';

-- 1. Build the new rollup alongside the old one. ------------------------------
drop materialized view if exists public.sales_by_product_title_daily_mv_new;

create materialized view public.sales_by_product_title_daily_mv_new as
with canonical_title as (
  -- One title per (company, sku): the published store copy wins. distinct on
  -- needs every tiebreak to be total, or a refresh could pick differently from
  -- the same data and silently move numbers between titles.
  select distinct on (ps.company_entity_id, ps.sku)
    ps.company_entity_id,
    ps.sku,
    ps.product_title
  from public.shopify_product_skus ps
  where ps.sku is not null
    and ps.product_title is not null
  order by
    ps.company_entity_id,
    ps.sku,
    (coalesce(ps.shopify_status, '') = 'active') desc,
    (ps.online_published_at is not null) desc,
    ps.last_seen_at desc nulls last,
    ps.shop_domain,
    ps.shopify_product_id desc
)
select
  s.company_entity_id,
  coalesce(ct.product_title, pm.product_title, s.product_name) as product_title,
  case when ct.sku is not null or pm.sku is not null then 'products_master'
       else 'sales_fallback' end                               as title_source,
  coalesce(pm.product_type, s.product_type)                    as product_type,
  s.location_tag,
  s.day_date,
  count(distinct s.sku)                                        as variant_skus,
  sum(s.total_quantity_sold)                                   as units_sold,
  sum(s.total_orders)                                          as orders,
  sum(s.total_gross_sales)                                     as gross_sales,
  sum(s.total_discounts)                                       as discounts,
  sum(s.total_refunds)                                         as refunds,
  sum(s.total_net_sales)                                       as net_sales
from public.sales_by_day s
left join public.products_master pm
  on pm.sku = s.sku
 and pm.company_entity_id = s.company_entity_id
left join canonical_title ct
  on ct.sku = s.sku
 and ct.company_entity_id = s.company_entity_id
group by 1, 2, 3, 4, 5, 6;

-- Same two indexes, same NULLS NOT DISTINCT reasoning as the original: three
-- of the six grain columns are nullable, and a plain unique index both fails to
-- be unique over this grain and disqualifies REFRESH ... CONCURRENTLY.
create unique index sales_by_product_title_daily_mv_new_key
  on public.sales_by_product_title_daily_mv_new
     (company_entity_id, product_title, title_source, product_type, location_tag, day_date)
  nulls not distinct;

create index sales_by_product_title_daily_mv_new_day_idx
  on public.sales_by_product_title_daily_mv_new (company_entity_id, day_date);

analyze public.sales_by_product_title_daily_mv_new;

-- 2. Verify before swapping. --------------------------------------------------
-- The rollup must still be sales_by_day, only grouped differently: a title
-- rule that dropped or duplicated a row would move money, which is exactly
-- what this migration exists to stop.
do $$
declare
  s_qty numeric; s_ord numeric; s_gross numeric; s_disc numeric; s_ref numeric; s_net numeric;
  m_qty numeric; m_ord numeric; m_gross numeric; m_disc numeric; m_ref numeric; m_net numeric;
  n_rows bigint;
  n_null bigint;
begin
  select coalesce(sum(total_quantity_sold),0), coalesce(sum(total_orders),0),
         coalesce(sum(total_gross_sales),0), coalesce(sum(total_discounts),0),
         coalesce(sum(total_refunds),0), coalesce(sum(total_net_sales),0)
    into s_qty, s_ord, s_gross, s_disc, s_ref, s_net
    from public.sales_by_day;

  select coalesce(sum(units_sold),0), coalesce(sum(orders),0),
         coalesce(sum(gross_sales),0), coalesce(sum(discounts),0),
         coalesce(sum(refunds),0), coalesce(sum(net_sales),0), count(*)
    into m_qty, m_ord, m_gross, m_disc, m_ref, m_net, n_rows
    from public.sales_by_product_title_daily_mv_new;

  if (s_qty, s_ord, s_gross, s_disc, s_ref, s_net)
     is distinct from (m_qty, m_ord, m_gross, m_disc, m_ref, m_net) then
    raise exception
      'product-title rollup does not tie to sales_by_day: qty %/%, orders %/%, gross %/%, disc %/%, refunds %/%, net %/%',
      m_qty, s_qty, m_ord, s_ord, m_gross, s_gross, m_disc, s_disc, m_ref, s_ref, m_net, s_net;
  end if;

  if n_rows = 0 then
    raise exception 'product-title rollup built empty';
  end if;

  -- A null title would be a product nobody can name or filter. The old
  -- definition could only produce one if all three sources were null; so can
  -- this one, and it must not have started doing it more often.
  select count(*) into n_null
    from public.sales_by_product_title_daily_mv_new where product_title is null;
  if n_null > (select count(*) from public.sales_by_product_title_daily_mv where product_title is null) then
    raise exception 'product-title rollup produced % untitled rows, more than before', n_null;
  end if;

  raise notice 'product-title rollup verified: % rows, % units, % net', n_rows, m_qty, m_net;
end $$;

-- Titles must not fragment a product MORE than before. Counted over
-- store-products (a shop's own Shopify product) that have sold in the last
-- year, which is the grain a buyer reads a title at.
do $$
declare
  before_split bigint;
  after_split bigint;
begin
  with sold as (
    select distinct s.company_entity_id, s.shop_domain, s.sku
      from public.sales_by_day s
     where s.sku is not null
       and s.day_date >= current_date - 365
  ), prod as (
    select distinct ps.company_entity_id, ps.shop_domain, ps.shopify_product_id, ps.sku
      from public.shopify_product_skus ps
     where ps.sku is not null
  ), canonical_title as (
    select distinct on (ps.company_entity_id, ps.sku)
           ps.company_entity_id, ps.sku, ps.product_title
      from public.shopify_product_skus ps
     where ps.sku is not null and ps.product_title is not null
     order by ps.company_entity_id, ps.sku,
              (coalesce(ps.shopify_status, '') = 'active') desc,
              (ps.online_published_at is not null) desc,
              ps.last_seen_at desc nulls last,
              ps.shop_domain, ps.shopify_product_id desc
  ), g as (
    select p.company_entity_id, p.shop_domain, p.shopify_product_id,
           count(distinct pm.product_title) as old_titles,
           count(distinct ct.product_title) as new_titles
      from sold
      join prod p using (company_entity_id, shop_domain, sku)
      left join public.products_master pm
        on pm.company_entity_id = p.company_entity_id and pm.sku = p.sku
      left join canonical_title ct
        on ct.company_entity_id = p.company_entity_id and ct.sku = p.sku
     group by 1, 2, 3
  )
  select count(*) filter (where old_titles > 1),
         count(*) filter (where new_titles > 1)
    into before_split, after_split
    from g;

  if after_split > before_split then
    raise exception 'canonical title splits MORE products than products_master did (% -> %)',
      before_split, after_split;
  end if;
  raise notice 'store-products split across titles: % -> %', before_split, after_split;
end $$;

-- 3. Swap, carrying every dependent view across. ------------------------------
--
-- A view records its source by OID, so renaming the matview underneath one
-- does not repoint it: every view in the rewrite-dependency closure has to be
-- dropped and rebuilt around the swap. Production taught this on 2026-11-04 --
-- the first apply died on `cannot drop view sales_by_product_title_daily_v
-- because other objects depend on it` and rolled the whole swap back, because
-- `reorder_plan_v` reads it and **exists in no migration in this repo**, so
-- its text is only in the database.
--
-- So the closure is CAPTURED here rather than transcribed: definition,
-- reloptions, comment and grants, walked to any depth, dropped deepest-first
-- and recreated shallowest-first exactly as found. That is also why this is
-- one DO block -- the captured definitions live in a local variable, so there
-- is no window in which a definition exists only in this session's memory and
-- not in the database. Any view a tenant's database carries over this rollup
-- that this file has never heard of is carried too, which is the point:
-- hand-applied objects are normal here.
begin;

do $$
declare
  deps  jsonb;
  dep   jsonb;
  g     jsonb;
  gr    record;
  opts  text;
begin
  with recursive closure as (
    select 'public.sales_by_product_title_daily_mv'::regclass as oid, 0 as lvl
    union all
    select d2.oid, closure.lvl + 1
      from closure
      join pg_depend dd  on dd.refobjid = closure.oid
      join pg_rewrite r  on r.oid = dd.objid
      join pg_class d2   on d2.oid = r.ev_class
     where d2.oid <> closure.oid
       and closure.lvl < 10
  ), v as (
    select c.oid, c.relname, max(closure.lvl) as lvl
      from closure
      join pg_class c on c.oid = closure.oid
     where c.relkind = 'v'
     group by c.oid, c.relname
  )
  select jsonb_agg(
           jsonb_build_object(
             'relname', v.relname,
             'lvl',     v.lvl,
             'def',     pg_get_viewdef(v.oid, true),
             'opts',    coalesce((select jsonb_agg(o) from unnest(c.reloptions) o), '[]'::jsonb),
             'cmt',     obj_description(v.oid),
             'grants',  coalesce((select jsonb_agg(jsonb_build_object(
                                     'grantee',   case when a.grantee = 0 then 'public'
                                                       else pg_get_userbyid(a.grantee) end,
                                     'priv',      a.privilege_type,
                                     'grantable', a.is_grantable))
                                    from aclexplode(c.relacl) a), '[]'::jsonb))
           order by v.lvl)
    into deps
    from v
    join pg_class c on c.oid = v.oid;

  if deps is null then
    raise exception 'no view reads sales_by_product_title_daily_mv; sales_by_product_title_daily_v should and the rollup is unreadable without it';
  end if;

  raise notice 'carrying % dependent view(s) across the swap: %',
    jsonb_array_length(deps),
    (select string_agg(d->>'relname', ', ' order by (d->>'lvl')::int)
       from jsonb_array_elements(deps) d);

  -- Deepest first: a view that reads another must go before the one it reads.
  for dep in select d from jsonb_array_elements(deps) d order by (d->>'lvl')::int desc loop
    execute format('drop view if exists public.%I', dep->>'relname');
  end loop;

  execute 'drop materialized view if exists public.sales_by_product_title_daily_mv';

  execute 'alter materialized view public.sales_by_product_title_daily_mv_new '
       || 'rename to sales_by_product_title_daily_mv';
  execute 'alter index public.sales_by_product_title_daily_mv_new_key '
       || 'rename to sales_by_product_title_daily_mv_key';
  execute 'alter index public.sales_by_product_title_daily_mv_new_day_idx '
       || 'rename to sales_by_product_title_daily_mv_day_idx';

  -- No RLS on a matview, so nobody reads it except through a wrapper. Done
  -- before the views are rebuilt, so the window where it is grantable is nil.
  execute 'revoke all on public.sales_by_product_title_daily_mv from public, anon, authenticated';

  -- Shallowest first, each exactly as it was found.
  for dep in select d from jsonb_array_elements(deps) d order by (d->>'lvl')::int loop
    opts := (select string_agg(o #>> '{}', ', ') from jsonb_array_elements(dep->'opts') o);

    execute format('create view public.%I %s as %s',
                   dep->>'relname',
                   case when opts is null or opts = '' then '' else 'with (' || opts || ')' end,
                   dep->>'def');

    if dep->>'cmt' is not null then
      execute format('comment on view public.%I is %L', dep->>'relname', dep->>'cmt');
    end if;

    -- `create view` re-applies Supabase's default privileges, which on this
    -- project grant arwdDxtm on every new relation in public to anon,
    -- authenticated and service_role. Replaying the captured grants on top of
    -- that would be defaults PLUS the old ACL: a wrapper whose anon access was
    -- explicitly revoked would come back readable by anon. So strip whatever
    -- the create just granted -- every grantee except the owner, read from the
    -- new object rather than from a hardcoded role list -- and only then put
    -- the captured ACL back. The result is the ACL as it was found, no more.
    for gr in select distinct
                     case when a.grantee = 0 then null
                          else pg_get_userbyid(a.grantee) end as grantee
                from pg_class c
                cross join aclexplode(c.relacl) a
               where c.oid = format('public.%I', dep->>'relname')::regclass
                 and a.grantee <> c.relowner
    loop
      execute format('revoke all on public.%I from %s',
                     dep->>'relname',
                     coalesce(quote_ident(gr.grantee), 'public'));
    end loop;

    for g in select x from jsonb_array_elements(dep->'grants') x loop
      execute format('grant %s on public.%I to %s%s',
                     g->>'priv',
                     dep->>'relname',
                     case when g->>'grantee' = 'public' then 'public'
                          else quote_ident(g->>'grantee') end,
                     case when (g->>'grantable')::boolean then ' with grant option' else '' end);
    end loop;
  end loop;
end $$;

comment on materialized view public.sales_by_product_title_daily_mv is
  'Stored form of sales_by_product_title_daily_v -- identical select list and grain, not a further aggregation. Exists because the unbounded reads (max(day_date) inside the Top products report, open-ended date_from on the Logistics tile) had to build the entire 700k-group rollup to answer, measured 6,890ms. The title is resolved per (company, sku) from shopify_product_skus, preferring the published store copy (active, then published-at present, then most recently seen), and falls back to products_master then sales_by_day.product_name -- products_master alone is one row per SKU across every store, so it carried whichever store synced last. Refreshed by refresh_sales_by_product_title_mv() at the end of the Shopify sync. READ THROUGH sales_by_product_title_daily_v, NEVER DIRECTLY: this carries no RLS and no grant, so a direct read raises 42501 and a granted one would leak across companies.';

-- The wrapper's definition is unchanged and was replayed verbatim above; only
-- what it promises about the title is new.
comment on view public.sales_by_product_title_daily_v is
  'Sales rolled up from SKU variants to product title, per location per day. The grain buying decisions are made at, and the one place the title join is defined. The title is ONE canonical title per (company, sku): the published store copy from shopify_product_skus (active, then published-at present, then most recently seen, then shop_domain, then product id), falling back to products_master.product_title and then sales_by_day.product_name. It is deliberately not the selling store''s own title -- 796 SKUs are published in two stores under different names, so a per-store title would split a product in company-wide rollups. title_source = ''sales_fallback'' means no catalog row resolved the SKU at all and the title came from sales_by_day.product_name -- those are still counted, never dropped. Reads sales_by_product_title_daily_mv, so it is as of the last Shopify sync rather than live; security_invoker = false with an explicit company_entity_id = active_company_id() filter, which is the same predicate the RLS policies on the base tables carry. Note ''x-redo'' (Package Protection) is the Redo checkout line item, not merchandise -- filter it when ranking real products.';

commit;

-- 4. Prove the swap landed whole. --------------------------------------------
do $$
declare
  missing text[] := array[]::text[];
  v record;
begin
  if to_regclass('public.sales_by_product_title_daily_mv') is null then
    missing := missing || 'sales_by_product_title_daily_mv';
  end if;
  if to_regclass('public.sales_by_product_title_daily_v') is null then
    missing := missing || 'sales_by_product_title_daily_v';
  end if;
  if to_regclass('public.sales_by_product_title_daily_mv_new') is not null then
    missing := missing || 'temporary matview still present';
  end if;
  if array_length(missing, 1) > 0 then
    raise exception 'swap incomplete: %', array_to_string(missing, ', ');
  end if;

  -- The matview must stay unreadable except through the wrapper.
  if has_table_privilege('authenticated', 'public.sales_by_product_title_daily_mv', 'select') then
    raise exception 'sales_by_product_title_daily_mv is readable by authenticated; the tenant filter would be bypassable';
  end if;
  if not has_table_privilege('authenticated', 'public.sales_by_product_title_daily_v', 'select') then
    raise exception 'sales_by_product_title_daily_v is not readable by authenticated; every report would 42501';
  end if;

  -- Every view that was carried across has to be back, readable, and selectable.
  for v in select c.relname
             from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public'
              and c.relkind = 'v'
              and c.relname in ('product_type_forecastable_v', 'reorder_plan_v')
  loop
    if not has_table_privilege('authenticated', format('public.%I', v.relname), 'select') then
      raise exception '% is not readable by authenticated after the swap', v.relname;
    end if;
  end loop;

  if to_regclass('public.product_type_forecastable_v') is null then
    raise exception 'product_type_forecastable_v was dropped and not recreated';
  end if;

  -- The refresh path the Shopify sync calls must still resolve.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'refresh_sales_by_product_title_mv'
  ) then
    raise exception 'refresh_sales_by_product_title_mv() is missing';
  end if;

  raise notice 'product-title rollup swapped: the rollup, its wrapper and every dependent view are present';
end $$;
