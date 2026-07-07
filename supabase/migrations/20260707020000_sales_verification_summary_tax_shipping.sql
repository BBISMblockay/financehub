-- Adds Taxes/Shipping sums to sales_verification_filtered_summary()'s
-- by-location breakdown, for the Sales Report page's "By location" table
-- and its CSV export.
--
-- Line detail (row-level) already showed taxes/shipping per row; the
-- location rollup never summed them. Needed for accounting reconciliation
-- (matches the legacy Power BI store-level report's SUM Taxes / SUM
-- Shipping columns).

create or replace function public.sales_verification_filtered_summary(
  p_date_from date default null,
  p_date_to date default null,
  p_location_tag text default null,
  p_search text default null,
  p_quick text default 'all'
)
returns jsonb
language plpgsql
stable
set search_path to 'public'
as $function$
declare
  v_company uuid;
  v_search text;
  v_result jsonb;
begin
  v_company := active_company_id();
  if v_company is null then
    return jsonb_build_object(
      'total_rows', 0, 'total_units', 0, 'total_net', 0, 'total_refunds', 0,
      'min_date', null, 'max_date', null, 'refund_discrepancy_count', 0,
      'blank_sku_count', 0, 'negative_net_count', 0, 'batch_count', 0,
      'location_count', 0, 'locations', '[]'::jsonb
    );
  end if;
  v_search := nullif(trim(p_search), '');
  if v_search is not null then v_search := '%' || v_search || '%'; end if;
  with filtered as (
    select s.location_tag, s.day_date, s.product_name, s.sku, s.sync_batch_id,
      s.total_quantity_sold, s.total_gross_sales, s.total_discounts, s.total_refunds,
      s.total_net_sales, s.taxes, s.shipping,
      coalesce(s.sum_total_sales, s.total_sales) as total_sales
    from public.sales_by_day_verification_v s
    where s.company_entity_id = v_company
      and (p_location_tag is null or p_location_tag = '' or s.location_tag = p_location_tag)
      and (p_date_from is null or s.day_date >= p_date_from)
      and (p_date_to is null or s.day_date <= p_date_to)
      and (v_search is null or s.product_name ilike v_search or s.sku ilike v_search
        or s.vendor_original ilike v_search or s.product_type ilike v_search)
      and (coalesce(p_quick, 'all') = 'all'
        or (p_quick = 'refund_discrepancy' and (lower(coalesce(s.product_name, '')) = '[refund discrepancy]'
          or lower(coalesce(s.sku, '')) = '[refund discrepancy]'))
        or (p_quick = 'blank_sku' and coalesce(trim(s.sku), '') = '')
        or (p_quick = 'negative_net' and coalesce(s.total_net_sales, 0) < 0))
  ), totals as (
    select count(*)::bigint as total_rows,
      coalesce(sum(total_quantity_sold), 0)::bigint as total_units,
      coalesce(sum(total_net_sales), 0) as total_net,
      coalesce(sum(total_refunds), 0) as total_refunds,
      min(day_date) as min_date, max(day_date) as max_date,
      count(*) filter (where lower(coalesce(product_name, '')) = '[refund discrepancy]'
        or lower(coalesce(sku, '')) = '[refund discrepancy]')::bigint as refund_discrepancy_count,
      count(*) filter (where coalesce(trim(sku), '') = '')::bigint as blank_sku_count,
      count(*) filter (where coalesce(total_net_sales, 0) < 0)::bigint as negative_net_count,
      count(distinct sync_batch_id) filter (where sync_batch_id is not null)::bigint as batch_count
    from filtered
  ), by_location as (
    select coalesce(location_tag, 'unknown') as location_tag, count(*)::bigint as row_count,
      min(day_date) as min_date, max(day_date) as max_date,
      coalesce(sum(total_quantity_sold), 0)::bigint as units,
      coalesce(sum(total_gross_sales), 0) as gross,
      coalesce(sum(total_discounts), 0) as discounts,
      coalesce(sum(total_refunds), 0) as refunds,
      coalesce(sum(taxes), 0) as taxes,
      coalesce(sum(shipping), 0) as shipping,
      coalesce(sum(total_net_sales), 0) as net,
      coalesce(sum(total_sales), 0) as total_sales
    from filtered group by coalesce(location_tag, 'unknown') order by location_tag
  )
  select jsonb_build_object(
    'total_rows', t.total_rows, 'total_units', t.total_units, 'total_net', t.total_net,
    'total_refunds', t.total_refunds, 'min_date', t.min_date, 'max_date', t.max_date,
    'refund_discrepancy_count', t.refund_discrepancy_count, 'blank_sku_count', t.blank_sku_count,
    'negative_net_count', t.negative_net_count, 'batch_count', t.batch_count,
    'location_count', (select count(*)::bigint from by_location),
    'locations', coalesce((select jsonb_agg(to_jsonb(bl) order by bl.location_tag) from by_location bl), '[]'::jsonb)
  ) into v_result from totals t;
  return v_result;
end;
$function$;
