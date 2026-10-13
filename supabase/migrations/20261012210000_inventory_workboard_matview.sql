-- Materialize inventory_workboard_v. Speed only: the rows it returns do not change.
--
-- WHY. /v2/inventory.html fetches this view in seven 10,000-row pages (67,605
-- rows for Baseballism). PostgREST turns each page into LIMIT/OFFSET, and this
-- view's plan has to build the WHOLE result before it can honour an offset --
-- the 57,330-group SKU-fallback aggregate is built in full every time, and the
-- nested loop into the velocity matview runs for every row up to the offset.
-- So the cost climbs with the offset and the page pays for the same work seven
-- times over. Measured on production as `authenticated`, 2026-10-12, with the
-- exact 28-column projection the page requests:
--
--   offset 0      454ms   (10,000 rows scanned)
--   offset 30000 1,319ms  (40,000 rows scanned)
--   offset 60000 2,123ms  (67,605 rows scanned, 422,566 buffer hits)
--
-- ~8.6s of database time, serialized, to deliver what one pass does in 2.1s:
-- the pagination alone multiplies the work about fourfold. Within one request,
-- 1.7s of the 2.1s is the nested loop into sales_velocity_by_sku_location_mv --
-- 62,499 index probes with the memoize cache thrashing (18,950 evictions on a
-- 10MB cache) because the join keys are expressions (lower(trim(...))) and so
-- carry no statistics.
--
-- Both of those are the same problem: work redone per request that only needs
-- doing when the data changes. This view reads nothing but two matviews that
-- the nightly sync refreshes (scripts/sync-silo-inventory-sales.mjs refreshes
-- sales_velocity_by_sku_location_mv, then inventory_on_hand_current_mv), so a
-- matview refreshed in the same place loses NO freshness at all, and every page
-- request becomes an index scan.
--
-- WHAT STAYS THE SAME. The view keeps its name, its 40 columns in the same
-- order and the same types, so `/v2/inventory.html` and every other caller
-- (report tie-outs 20260904300000, logistics reports 20260904160000, the
-- insights engine 20260709050000, the canned-report accuracy checks
-- 20260920075344, the report-builder catalog) are untouched. Proved on
-- production before writing this, as `authenticated` against the live view
-- versus this exact definition: identical row count (67,605), identical
-- sold_30 total (67,789), identical units (524,992), identical matched count
-- (40,599), identical days_oos count (7,192), and an identical md5 fingerprint
-- of every row's velocity-derived columns ordered by id
-- (38f0ec9784827661b078f3847a7a5639 both sides).
--
-- THE ONE REAL CHANGE, AND WHY IT IS REQUIRED. Today both sides of the join are
-- already scoped to one company, because the view reads the company-filtered
-- wrapper views inventory_on_hand_current_v / sales_velocity_by_sku_location_v.
-- A matview has no caller, so it is built across ALL companies -- and then
-- company_entity_id MUST be part of every join key, or one company's inventory
-- matches another's velocity. This is not hypothetical: two companies have
-- inventory rows and three have velocity rows. Measured both ways on 2026-10-12:
--
--   with company in the join keys     Baseballism 67,605 rows  (correct)
--   without it                        Baseballism 68,931 rows, and the second
--                                     company 5,203 rows of which 2,664 claim
--                                     matched velocity that is not its own
--
-- sales_velocity_mv_co_loc_sku_name is UNIQUE on (company_entity_id,
-- location_tag, variant_sku, product_name), so with company in the key the `t`
-- join matches AT MOST ONE row and cannot duplicate; without company it matches
-- on only three of the four unique columns, which is precisely where those
-- 1,326 extra rows come from. The `a` join is a GROUP BY on (company,
-- location_tag, variant_sku) and so is single-valued by construction too.
-- Grouping by company changes nothing per company: today's groups are already
-- within one company because the wrapper filtered the input first.
--
-- NOT CHANGED HERE, on purpose: the page still fetches seven pages. Collapsing
-- that into one request is the other half of the win, but this repo is
-- statically hosted and the migration is applied by hand, so the page can go
-- live before the matview exists -- and one unpaginated request against the
-- un-materialized view is the exact thing that timed out cold and put the
-- pagination there in the first place (see the comment in v2/inventory.html).
-- It is a follow-up once this is confirmed applied.

begin;

do $mig$
declare
  mv_exists boolean;
  def       text;
  n_inv     bigint;
  n_mv      bigint;
  n_null    bigint;
  bad       text;
begin
  select exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'inventory_workboard_mv' and c.relkind = 'm'
  ) into mv_exists;

  if mv_exists then
    raise notice 'inventory_workboard_mv already exists; leaving it in place';
  else
    create materialized view public.inventory_workboard_mv as
      select i.id,
        i.location_tag,
        i.source,
        i.location,
        i.product_title,
        i.variant_title,
        i.variant_sku,
        i.shop_domain,
        i.variant_barcode,
        i.est_oos_date,
        i.variant_created_at,
        i.product_type,
        i.product_image,
        i.product_image_url,
        i.retail_price,
        i.total_available_quantity,
        i.total_available_inventory_value,
        i.qty_sold_30d,
        i.avg_qty_sold_per_day,
        i.est_days_before_oos,
        i.snapshot_at,
        i.row_hash,
        i.location_name,
        i.sync_batch_id,
        i.company_entity_id,
        coalesce(t.qty_7d,   a.qty_7d,   0::bigint)  as qty_7d,
        coalesce(t.qty_30d,  a.qty_30d,  0::bigint)  as sold_30,
        coalesce(t.qty_90d,  a.qty_90d,  0::bigint)  as qty_90d,
        coalesce(t.qty_120d, a.qty_120d, 0::bigint)  as qty_120d,
        coalesce(t.qty_365d, a.qty_365d, 0::bigint)  as qty_365d,
        coalesce(t.avg_day_7,   a.avg_day_7,   0::numeric) as avg_day_7,
        coalesce(t.avg_day_30,  a.avg_day_30,  0::numeric) as avg_day_30,
        coalesce(t.avg_day_90,  a.avg_day_90,  0::numeric) as avg_day_90,
        coalesce(t.avg_day_120, a.avg_day_120, 0::numeric) as avg_day_120,
        coalesce(t.avg_day_365, a.avg_day_365, 0::numeric) as avg_day_365,
        coalesce(t.last_sold_date, a.last_sold_date) as last_sold_date,
        case
          when coalesce(t.avg_day_30, a.avg_day_30, 0::numeric) > 0::numeric
            then round(coalesce(i.total_available_quantity, 0)::numeric / coalesce(t.avg_day_30, a.avg_day_30), 1)
          when coalesce(t.avg_day_7, a.avg_day_7, 0::numeric) > 0::numeric
            then round(coalesce(i.total_available_quantity, 0)::numeric / coalesce(t.avg_day_7, a.avg_day_7), 1)
          else null::numeric
        end as days_oos,
        case
          when coalesce(t.avg_day_30, a.avg_day_30, 0::numeric) > 0::numeric then '30d'::text
          when coalesce(t.avg_day_7,  a.avg_day_7,  0::numeric) > 0::numeric then '7d'::text
          else 'none'::text
        end as velocity_basis,
        t.variant_sku is not null or a.variant_sku is not null as velocity_matched,
        case
          when t.variant_sku is not null then 'title'::text
          when a.variant_sku is not null then 'sku_fallback'::text
          else 'none'::text
        end as velocity_source
      from public.inventory_on_hand_current_mv i
        -- company_entity_id first, so this uses all four columns of
        -- sales_velocity_mv_co_loc_sku_name and matches at most one row.
        left join public.sales_velocity_by_sku_location_mv t
          on t.company_entity_id = i.company_entity_id
         and t.location_tag = lower(trim(both from i.location_tag))
         and t.variant_sku = trim(both from i.variant_sku)
         and t.product_name = trim(both from i.product_title)
        left join (
          select sales_velocity_by_sku_location_mv.company_entity_id,
                 sales_velocity_by_sku_location_mv.location_tag,
                 sales_velocity_by_sku_location_mv.variant_sku,
                 count(*) as name_variants,
                 max(sales_velocity_by_sku_location_mv.qty_7d) as qty_7d,
                 max(sales_velocity_by_sku_location_mv.qty_30d) as qty_30d,
                 max(sales_velocity_by_sku_location_mv.qty_90d) as qty_90d,
                 max(sales_velocity_by_sku_location_mv.qty_120d) as qty_120d,
                 max(sales_velocity_by_sku_location_mv.qty_365d) as qty_365d,
                 max(sales_velocity_by_sku_location_mv.avg_day_7) as avg_day_7,
                 max(sales_velocity_by_sku_location_mv.avg_day_30) as avg_day_30,
                 max(sales_velocity_by_sku_location_mv.avg_day_90) as avg_day_90,
                 max(sales_velocity_by_sku_location_mv.avg_day_120) as avg_day_120,
                 max(sales_velocity_by_sku_location_mv.avg_day_365) as avg_day_365,
                 max(sales_velocity_by_sku_location_mv.last_sold_date) as last_sold_date
            from public.sales_velocity_by_sku_location_mv
           group by sales_velocity_by_sku_location_mv.company_entity_id,
                    sales_velocity_by_sku_location_mv.location_tag,
                    sales_velocity_by_sku_location_mv.variant_sku
        ) a
          on a.company_entity_id = i.company_entity_id
         and a.location_tag = lower(trim(both from i.location_tag))
         and a.variant_sku = trim(both from i.variant_sku)
         and a.name_variants = 1;
  end if;

  -- THE STRUCTURAL GUARD, and it has to come before the row-count ones because
  -- it catches what they cannot. A cross-tenant join does not necessarily
  -- change the row count: it only does so where a key exists in more than one
  -- company's velocity rows. Where the borrowed match is unique across
  -- companies, the counts agree perfectly and the only symptom is a wrong
  -- velocity number on one tenant's row -- which no count will ever notice.
  -- So the join keys are asserted directly, on the definition as Postgres
  -- stored it, whether this run created the matview or found one already there.
  --
  -- ONE ASSERTION PER JOIN, not a count of mentions. Counting is too weak, and
  -- the first version of this guard counted: the correct definition mentions
  -- company_entity_id seven times (select list, both velocity join keys, the
  -- fallback aggregate's select and GROUP BY), so deleting ONE of the two join
  -- predicates leaves five and a `>= 4` test still reports success -- while the
  -- remaining branch happily borrows another tenant's velocity on any key that
  -- is globally unique, without changing the row count. Found in review cycle 1
  -- of PR #953. Each predicate is therefore matched on its own, accepting
  -- either operand order because pg_get_viewdef is free to reorder an equality
  -- and to reparenthesise. verify_v2_schema.sql carries the same two checks.
  def := pg_get_viewdef('public.inventory_workboard_mv'::regclass, true);
  if def !~ '(t\.company_entity_id\s*=\s*i\.company_entity_id|i\.company_entity_id\s*=\s*t\.company_entity_id)' then
    raise exception
      'inventory_workboard_mv does not join the velocity matview on company_entity_id (the title-match join, alias t) -- it is built across every company, so one tenant''s inventory would take another tenant''s sales velocity on a matching location/sku/title; refusing to wire this up';
  end if;
  if def !~ '(a\.company_entity_id\s*=\s*i\.company_entity_id|i\.company_entity_id\s*=\s*a\.company_entity_id)' then
    raise exception
      'inventory_workboard_mv does not join the velocity fallback aggregate on company_entity_id (alias a) -- the sku-level fallback would take another tenant''s sales velocity on a matching location/sku; refusing to wire this up';
  end if;

  -- The LEFT JOINs must neither duplicate nor drop a row: both unique indexes
  -- above say they cannot, and this proves it on the real data rather than
  -- trusting the catalogue. It is also the invariant the report tie-out at
  -- 20260904300000 reconciles nightly ("Dead stock is ranked off
  -- inventory_workboard_v... this proves it does neither"), so a mismatch here
  -- is the same failure, caught before the matview is wired up.
  select count(*) into n_inv from public.inventory_on_hand_current_mv;
  select count(*) into n_mv  from public.inventory_workboard_mv;
  if n_inv <> n_mv then
    raise exception
      'inventory_workboard_mv has % rows against inventory_on_hand_current_mv''s % -- the velocity join duplicated or dropped rows, refusing to wire this up',
      n_mv, n_inv;
  end if;

  -- Per company as well as in total: equal totals could in principle hide a
  -- row gained by one tenant and lost by another, which is exactly the
  -- cross-tenant mistake this design exists to avoid.
  -- Per-company counts without a FULL JOIN: joining on `is not distinct from`
  -- is neither hash- nor merge-joinable, and Postgres refuses it outright
  -- (0A000). Taking the union of both sides' company ids and counting each one
  -- with a scalar subquery handles a null company id the same way without
  -- needing a join at all.
  select string_agg(format('%s: mv %s vs inv %s', coalesce(co::text, 'null'), m, v), '; ')
    into bad
    from (
      select co,
             (select count(*) from public.inventory_workboard_mv w
               where w.company_entity_id is not distinct from co) as m,
             (select count(*) from public.inventory_on_hand_current_mv o
               where o.company_entity_id is not distinct from co) as v
        from (
          select company_entity_id as co from public.inventory_workboard_mv
          union
          select company_entity_id from public.inventory_on_hand_current_mv
        ) cos
    ) q
   where m <> v;
  if bad is not null then
    raise exception 'inventory_workboard_mv row counts differ per company -- %', bad;
  end if;

  -- REFRESH ... CONCURRENTLY needs a unique index over non-null columns, and
  -- the wrapper below reads by company.
  select count(*) into n_null from public.inventory_workboard_mv where id is null;
  if n_null > 0 then
    raise exception
      'inventory_workboard_mv has % rows with a null id, so it cannot carry the unique index REFRESH CONCURRENTLY needs',
      n_null;
  end if;
end
$mig$;

create unique index if not exists inventory_workboard_mv_id_idx
  on public.inventory_workboard_mv (id);
create index if not exists inventory_workboard_mv_company_idx
  on public.inventory_workboard_mv (company_entity_id);
create index if not exists inventory_workboard_mv_company_sku_idx
  on public.inventory_workboard_mv (company_entity_id, variant_sku);

-- A matview has no RLS. It is reachable only through the wrapper view below,
-- exactly as 20260708060000 locked down the other three.
revoke all on public.inventory_workboard_mv from anon, authenticated, public;
grant select on public.inventory_workboard_mv to service_role;

-- The wrapper. security_invoker = false because the caller has no SELECT on the
-- matview (that is the point), and the company filter in the body is then the
-- tenant boundary -- the documented pattern in supabase/CLAUDE.md, the same one
-- inventory_on_hand_current_v and sales_velocity_by_sku_location_v already use.
-- auth.uid() resolves from the request JWT either way, so active_company_id()
-- still scopes rows per session user. Column list, order and types are
-- unchanged from the view this replaces.
create or replace view public.inventory_workboard_v as
  select id,
    location_tag,
    source,
    location,
    product_title,
    variant_title,
    variant_sku,
    shop_domain,
    variant_barcode,
    est_oos_date,
    variant_created_at,
    product_type,
    product_image,
    product_image_url,
    retail_price,
    total_available_quantity,
    total_available_inventory_value,
    qty_sold_30d,
    avg_qty_sold_per_day,
    est_days_before_oos,
    snapshot_at,
    row_hash,
    location_name,
    sync_batch_id,
    company_entity_id,
    qty_7d,
    sold_30,
    qty_90d,
    qty_120d,
    qty_365d,
    avg_day_7,
    avg_day_30,
    avg_day_90,
    avg_day_120,
    avg_day_365,
    last_sold_date,
    days_oos,
    velocity_basis,
    velocity_matched,
    velocity_source
  from public.inventory_workboard_mv
  where company_entity_id = public.active_company_id();

alter view public.inventory_workboard_v set (security_invoker = false);
grant select on public.inventory_workboard_v to authenticated;

-- Refreshed by the nightly sync, straight after the two matviews it reads.
-- CONCURRENTLY so the page keeps serving the previous snapshot during the
-- rebuild, with the plain form as a fallback for the cases CONCURRENTLY
-- refuses -- the same shape as refresh_sales_velocity_mv.
create or replace function public.refresh_inventory_workboard_mv()
returns void
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '300s'
as $fn$
begin
  begin
    refresh materialized view concurrently public.inventory_workboard_mv;
  exception when others then
    refresh materialized view public.inventory_workboard_mv;
  end;
end;
$fn$;

-- Not client-callable: a browser must never be able to kick a 300s refresh.
-- `create or replace` keeps existing grants and Supabase re-grants EXECUTE to
-- anon/authenticated on new public functions, so both are revoked explicitly.
revoke all on function public.refresh_inventory_workboard_mv() from anon, authenticated, public;
grant execute on function public.refresh_inventory_workboard_mv() to service_role;

-- ---------------------------------------------------------------------------
-- Keep the derived matview consistent with its two sources, wherever they are
-- refreshed from.
--
-- This is the correction from review cycle 1 of PR #953, and the finding was
-- right. The first version of this migration wired the workboard refresh into
-- scripts/sync-silo-inventory-sales.mjs, which is the entry point of
-- nightly-silo-sync.yml -- a workflow RETIRED on 2026-07-08 and left on
-- workflow_dispatch for emergencies. So on a scheduled run nothing would have
-- refreshed the workboard at all: the live Shopify sync refreshes both sources
-- and the stored workboard would have been frozen at whatever this migration
-- populated, indefinitely, while /v2/inventory.html, the dead-stock report and
-- Ask SILO all read it.
--
-- The invariant to restore is specific, and it is stronger than the one
-- demand_coverage_base_mv needs. Before this migration inventory_workboard_v
-- was a live join, so it ALWAYS agreed with inventory_on_hand_current_v and
-- sales_velocity_by_sku_location_v -- unconditionally, by construction, no
-- matter who refreshed what. Materializing it is only safe if that stays true.
-- Three separate call sites refresh those sources today
-- (scripts/shopify-sync.mjs, the "Refresh inventory mat view" retry step in
-- .github/workflows/shopify-sync.yml, and handleInventorySnapshot in
-- supabase/functions/shopify-sync-run/index.ts), and a fourth would be
-- added by anyone who needs a snapshot later. Hand-wiring each one is three
-- chances to forget -- this migration already demonstrated what forgetting
-- looks like -- and one of the three is an edge function, where a source
-- change does not take effect until it is deployed by hand.
--
-- So the ordering lives in the database instead: refreshing either source
-- refreshes what is derived from it, in the same call, for every caller that
-- exists now or later, with no client change and no deploy. The bodies below
-- are the deployed ones read from pg_get_functiondef (not retyped from a
-- migration file), each with its own statement_timeout and its own fallback
-- behaviour preserved exactly; the only addition is the trailing refresh.
--
-- A failure of the derived refresh is raised, not swallowed, because a stale
-- workboard disagrees with inventory_on_hand_current_v and would turn the
-- 20260904300000 dead-stock tie-out red with no indication of the cause. It is
-- re-raised with its own name in the message so the caller's log does not
-- blame the source refresh, which did succeed.
--
-- The hourly sales cron ('0 */2 * * *') deliberately skips the inventory
-- refresh, so chaining on velocity as well is what keeps sold_30 current
-- between nightly runs -- exactly as the live join did.
--
-- Two overlapping refreshes serialize on the matview lock rather than
-- corrupting anything (shopify-sync.yml takes no concurrency group on purpose),
-- and 300s is the inner timeout.

-- statement_timeout raised from the deployed 120s to 300s, matching
-- refresh_sales_velocity_mv and refresh_demand_coverage_base_mv (both already
-- 300s; 120s was the outlier). The reason is this change and nothing else: 120s
-- was sized for a body that only refreshed the snapshot, and whether a nested
-- function's own higher SET re-arms the timer for the statement already in
-- flight is not something worth depending on. The added refresh is seconds on
-- 67.6k rows, so this is headroom, not an expectation of needing it.
create or replace function public.refresh_inventory_current_mv()
returns void
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '300s'
as $fn$
begin
  refresh materialized view concurrently public.inventory_on_hand_current_mv;

  -- Derived from the snapshot just refreshed; see the note above.
  begin
    perform public.refresh_inventory_workboard_mv();
  exception when others then
    raise exception
      'inventory_on_hand_current_mv refreshed, but the derived inventory_workboard_mv refresh failed: % -- /v2/inventory.html and the dead-stock tie-out now disagree with the snapshot',
      sqlerrm;
  end;
end;
$fn$;

create or replace function public.refresh_sales_velocity_mv()
returns void
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '300s'
as $fn$
begin
  begin
    refresh materialized view concurrently public.sales_velocity_by_sku_location_mv;
  exception when others then
    refresh materialized view public.sales_velocity_by_sku_location_mv;
  end;

  -- Derived from the velocity rows just refreshed; see the note above. This is
  -- the path that keeps sold_30 and days_oos current on the hourly sales cron,
  -- which skips the inventory refresh.
  begin
    perform public.refresh_inventory_workboard_mv();
  exception when others then
    raise exception
      'sales_velocity_by_sku_location_mv refreshed, but the derived inventory_workboard_mv refresh failed: % -- /v2/inventory.html velocity now disagrees with sales_velocity_by_sku_location_v',
      sqlerrm;
  end;
end;
$fn$;

-- Unchanged privileges, restated because `create or replace` keeps the old
-- grants and Supabase re-grants EXECUTE on public functions to anon and
-- authenticated. Neither of these was ever client-callable.
revoke all on function public.refresh_inventory_current_mv() from anon, authenticated, public;
revoke all on function public.refresh_sales_velocity_mv() from anon, authenticated, public;
grant execute on function public.refresh_inventory_current_mv() to service_role;
grant execute on function public.refresh_sales_velocity_mv() to service_role;

-- Ask SILO's schema map describes public tables and views; this adds one.
select public.refresh_chat_schema_catalog();

commit;
