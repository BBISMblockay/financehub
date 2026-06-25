-- sales_verification_filtered_summary was reading s.total_sales (null for Shopify rows)
-- instead of s.sum_total_sales. Use coalesce to support both sources.

CREATE OR REPLACE FUNCTION public.sales_verification_filtered_summary(
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_location_tag text DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_quick text DEFAULT 'all'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_company uuid;
  v_search text;
  v_result jsonb;
BEGIN
  v_company := active_company_id();
  IF v_company IS NULL THEN
    RETURN jsonb_build_object(
      'total_rows', 0,
      'total_units', 0,
      'total_net', 0,
      'total_refunds', 0,
      'min_date', NULL,
      'max_date', NULL,
      'refund_discrepancy_count', 0,
      'blank_sku_count', 0,
      'negative_net_count', 0,
      'batch_count', 0,
      'location_count', 0,
      'locations', '[]'::jsonb
    );
  END IF;

  v_search := NULLIF(trim(p_search), '');
  IF v_search IS NOT NULL THEN
    v_search := '%' || v_search || '%';
  END IF;

  WITH filtered AS (
    SELECT
      s.location_tag,
      s.day_date,
      s.product_name,
      s.sku,
      s.sync_batch_id,
      s.total_quantity_sold,
      s.total_gross_sales,
      s.total_discounts,
      s.total_refunds,
      s.total_net_sales,
      coalesce(s.sum_total_sales, s.total_sales) AS total_sales
    FROM public.sales_by_day s
    WHERE s.company_entity_id = v_company
      AND (p_location_tag IS NULL OR p_location_tag = '' OR s.location_tag = p_location_tag)
      AND (p_date_from IS NULL OR s.day_date >= p_date_from)
      AND (p_date_to IS NULL OR s.day_date <= p_date_to)
      AND (
        v_search IS NULL
        OR s.product_name ILIKE v_search
        OR s.sku ILIKE v_search
        OR s.vendor_original ILIKE v_search
        OR s.product_type ILIKE v_search
      )
      AND (
        coalesce(p_quick, 'all') = 'all'
        OR (
          p_quick = 'refund_discrepancy'
          AND (
            lower(coalesce(s.product_name, '')) = '[refund discrepancy]'
            OR lower(coalesce(s.sku, '')) = '[refund discrepancy]'
          )
        )
        OR (p_quick = 'blank_sku' AND coalesce(trim(s.sku), '') = '')
        OR (p_quick = 'negative_net' AND coalesce(s.total_net_sales, 0) < 0)
      )
  ),
  totals AS (
    SELECT
      count(*)::bigint AS total_rows,
      coalesce(sum(total_quantity_sold), 0)::bigint AS total_units,
      coalesce(sum(total_net_sales), 0) AS total_net,
      coalesce(sum(total_refunds), 0) AS total_refunds,
      min(day_date) AS min_date,
      max(day_date) AS max_date,
      count(*) FILTER (
        WHERE lower(coalesce(product_name, '')) = '[refund discrepancy]'
           OR lower(coalesce(sku, '')) = '[refund discrepancy]'
      )::bigint AS refund_discrepancy_count,
      count(*) FILTER (WHERE coalesce(trim(sku), '') = '')::bigint AS blank_sku_count,
      count(*) FILTER (WHERE coalesce(total_net_sales, 0) < 0)::bigint AS negative_net_count,
      count(DISTINCT sync_batch_id) FILTER (WHERE sync_batch_id IS NOT NULL)::bigint AS batch_count
    FROM filtered
  ),
  by_location AS (
    SELECT
      coalesce(location_tag, 'unknown') AS location_tag,
      count(*)::bigint AS row_count,
      min(day_date) AS min_date,
      max(day_date) AS max_date,
      coalesce(sum(total_quantity_sold), 0)::bigint AS units,
      coalesce(sum(total_gross_sales), 0) AS gross,
      coalesce(sum(total_discounts), 0) AS discounts,
      coalesce(sum(total_refunds), 0) AS refunds,
      coalesce(sum(total_net_sales), 0) AS net,
      coalesce(sum(total_sales), 0) AS total_sales
    FROM filtered
    GROUP BY coalesce(location_tag, 'unknown')
    ORDER BY location_tag
  )
  SELECT jsonb_build_object(
    'total_rows', t.total_rows,
    'total_units', t.total_units,
    'total_net', t.total_net,
    'total_refunds', t.total_refunds,
    'min_date', t.min_date,
    'max_date', t.max_date,
    'refund_discrepancy_count', t.refund_discrepancy_count,
    'blank_sku_count', t.blank_sku_count,
    'negative_net_count', t.negative_net_count,
    'batch_count', t.batch_count,
    'location_count', (SELECT count(*)::bigint FROM by_location),
    'locations', coalesce((SELECT jsonb_agg(to_jsonb(bl) ORDER BY bl.location_tag) FROM by_location bl), '[]'::jsonb)
  )
  INTO v_result
  FROM totals t;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.sales_verification_filtered_summary(date, date, text, text, text)
  TO authenticated;
