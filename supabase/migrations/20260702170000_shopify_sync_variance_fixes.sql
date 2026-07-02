-- Shopify sync variance fixes (BR vs shopify_api reconciliation).
--
-- 1. row_hash for shopify_api rows now includes shop_domain, matching the
--    updated sync code — without it, two shops feeding the same SILO
--    location_tag (e.g. main-store "Baseballism Atlanta" + the Atlanta shop)
--    overwrite each other's (day, location, sku) aggregates on upsert.
-- 2. purge_better_reports_overlap rewritten as an indexed semi-join. The old
--    DELETE ... USING self-join fanned out on a ~1M-row table and timed out,
--    which is why better_reports and shopify_api rows currently coexist for
--    recent days (double-counted by pages that don't filter on source).
-- 3. default_location_code for the main + wholesale shops, so orders with no
--    location on them yet (unfulfilled online/wholesale orders) are attributed
--    instead of dropped.
-- 4. Deactivate duplicate active connections per shop_domain (chicago + dsg
--    each had two); a history backfill purges by shop_domain, so duplicate
--    connections stomp each other's imported ranges.
--
-- Note: the row_hash recompute updates every shopify_api row; if the SQL
-- editor times out, run this file via psql or re-run — it is idempotent.

-- ── 1. row_hash includes shop_domain ────────────────────────────────────────

create extension if not exists pgcrypto with schema extensions;

set statement_timeout = '600s';

do $$
begin
  perform set_config('search_path', 'public, extensions', true);

  -- Mirrors hashRow() in scripts/lib/shopify-sync-core.mjs:
  -- [company, location_tag, day, sku, product_name, shop_domain, source] joined by '|'
  update public.sales_by_day
     set row_hash = encode(digest(
           company_entity_id::text        || '|' ||
           location_tag                   || '|' ||
           to_char(day_date, 'YYYY-MM-DD') || '|' ||
           coalesce(sku, '')              || '|' ||
           coalesce(product_name, '')     || '|' ||
           coalesce(shop_domain, '')      || '|' ||
           source, 'sha256'), 'hex')
   where source = 'shopify_api';
end $$;

-- ── 2. fast overlap purge + supporting indexes ──────────────────────────────

create index if not exists sales_by_day_shopify_api_loc_day_idx
  on public.sales_by_day (company_entity_id, location_tag, day_date)
  where source = 'shopify_api';

-- speeds the per-shop day-rebuild delete in runIncrementalSales
create index if not exists sales_by_day_shop_domain_day_idx
  on public.sales_by_day (shop_domain, day_date)
  where source = 'shopify_api';

create or replace function public.purge_better_reports_overlap(
  p_company_entity_id uuid default '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
)
returns table(deleted_rows bigint)
language plpgsql
security definer
set search_path = public
set statement_timeout = '300s'
as $$
declare
  v_deleted bigint;
begin
  delete from public.sales_by_day br
  where br.source = 'better_reports'
    and br.company_entity_id = p_company_entity_id
    and exists (
      select 1
      from public.sales_by_day api
      where api.source            = 'shopify_api'
        and api.company_entity_id = br.company_entity_id
        and api.location_tag      = br.location_tag
        and api.day_date          = br.day_date
    );

  get diagnostics v_deleted = row_count;
  return query select v_deleted;
end;
$$;

grant execute on function public.purge_better_reports_overlap(uuid) to service_role;

-- ── 3. default location for order rows with no resolvable location ──────────

update public.shopify_connections
   set default_location_code = 'online'
 where shop_domain = 'baseballism.myshopify.com'
   and coalesce(default_location_code, '') = '';

update public.shopify_connections
   set default_location_code = 'wholesale'
 where shop_domain = 'baseballismwholesale.myshopify.com'
   and coalesce(default_location_code, '') = '';

-- ── 4. deactivate duplicate connections per shop ────────────────────────────

with ranked as (
  select id,
         row_number() over (
           partition by company_entity_id, shop_domain
           order by (meta -> 'history_backfill' ->> 'range_end') desc nulls last,
                    created_at desc,
                    id desc
         ) as rn
  from public.shopify_connections
  where is_active
)
update public.shopify_connections c
   set is_active    = false,
       sync_enabled = false,
       updated_at   = now()
  from ranked r
 where c.id = r.id
   and r.rn > 1;
