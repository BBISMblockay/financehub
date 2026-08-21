-- Product Search (v2/bi-product-search.html) was fetching every raw
-- sales_by_day_verification_v row for the selected date range and doing
-- the product/type rollup client-side in JS -- 50,502 rows for the default
-- 30-day window, 159,167 for 90d, 291,092 for 180d. That's what "loading is
-- still pretty heavy" is: shipping and re-aggregating tens/hundreds of
-- thousands of rows in the browser on every load and every filter change.
-- This was already flagged as a known follow-up in the 2026-08-20 CHANGELOG
-- entry ("a server-side aggregate RPC for the BI suite is the scoped-out
-- follow-up").
--
-- This RPC does the day-level SUM in Postgres instead of in the browser,
-- collapsing to one row per (location, sku, product, [month]) instead of
-- one row per (location, sku, product, day) -- e.g. 90d drops from 159,167
-- rows to 18,102 (no month) since row count is now bounded by the catalog
-- size, not the date range. Location is always kept (so the existing
-- client-side store-group filter and "Add Store column" toggle need no
-- refetch); month is optional (p_group_month) since "Add Store column"
-- stays instant but "Add Month column" now triggers one refetch at the
-- finer grain, matching the window-selector refetch pattern already used
-- elsewhere in the BI suite (bi-top-sellers.html).
--
-- security invoker (the default for a plain function, stated explicitly):
-- runs with the caller's own RLS, so it only ever sees sales_by_day rows
-- the caller's active company can already see -- no company_id parameter
-- needed, same as every other view in this schema.
create or replace function public.product_search_rollup(
  p_date_from date,
  p_date_to date,
  p_name_term text default null,
  p_sku_term text default null,
  p_group_month boolean default false
)
returns table (
  location_tag text,
  location_name text,
  sku text,
  product_name text,
  product_type text,
  month text,
  total_quantity_sold numeric,
  total_gross_sales numeric,
  total_discounts numeric,
  total_refunds numeric,
  total_net_sales numeric,
  total_sales numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    s.location_tag,
    s.location_name,
    s.sku,
    s.product_name,
    coalesce(s.product_type, 'Uncategorized') as product_type,
    case when p_group_month then to_char(s.day_date, 'YYYY-MM') else null end as month,
    sum(s.total_quantity_sold) as total_quantity_sold,
    sum(s.total_gross_sales) as total_gross_sales,
    sum(s.total_discounts) as total_discounts,
    sum(s.total_refunds) as total_refunds,
    sum(s.total_net_sales) as total_net_sales,
    sum(s.total_sales) as total_sales
  from public.sales_by_day_verification_v s
  where s.day_date >= p_date_from
    and s.day_date <= p_date_to
    and (
      p_name_term is null or p_name_term = ''
      or s.product_name ilike '%' || replace(replace(replace(p_name_term, '\', '\\'), '%', '\%'), '_', '\_') || '%'
    )
    and (
      p_sku_term is null or p_sku_term = ''
      or s.sku ilike '%' || replace(replace(replace(p_sku_term, '\', '\\'), '%', '\%'), '_', '\_') || '%'
    )
  group by
    s.location_tag, s.location_name, s.sku, s.product_name, coalesce(s.product_type, 'Uncategorized'),
    case when p_group_month then to_char(s.day_date, 'YYYY-MM') else null end
$$;

revoke all on function public.product_search_rollup(date, date, text, text, boolean) from public, anon;
grant execute on function public.product_search_rollup(date, date, text, text, boolean) to authenticated;
