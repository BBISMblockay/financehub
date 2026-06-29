-- Sales verification: prefer shopify_api over better_reports for the same location+day.
-- Fixes double-counting during Shopify cutover and wires purge_better_reports_overlap.

-- View used by Sales Verification UI + summary RPCs (RLS propagates via security_invoker).
CREATE OR REPLACE VIEW public.sales_by_day_verification_v
WITH (security_invoker = true) AS
SELECT s.*
FROM public.sales_by_day s
WHERE NOT (
  s.source = 'better_reports'
  AND EXISTS (
    SELECT 1
    FROM public.sales_by_day api
    WHERE api.company_entity_id = s.company_entity_id
      AND api.location_tag = s.location_tag
      AND api.day_date = s.day_date
      AND api.source = 'shopify_api'
  )
);

GRANT SELECT ON public.sales_by_day_verification_v TO authenticated;

-- Purge RPC (idempotent re-create for apply_all / fresh installs)
CREATE OR REPLACE FUNCTION public.purge_better_reports_overlap(
  p_company_entity_id uuid DEFAULT '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7'
)
RETURNS TABLE(deleted_rows bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted bigint;
BEGIN
  DELETE FROM public.sales_by_day br
  USING public.sales_by_day api
  WHERE br.source = 'better_reports'
    AND api.source = 'shopify_api'
    AND br.location_tag = api.location_tag
    AND br.day_date = api.day_date
    AND br.company_entity_id = p_company_entity_id
    AND api.company_entity_id = p_company_entity_id;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN QUERY SELECT v_deleted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.purge_better_reports_overlap(uuid) TO service_role;

-- Filtered summary: read deduped rows + coalesce total_sales columns
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
    FROM public.sales_by_day_verification_v s
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

-- Store comp summary refresh: aggregate deduped rows only
CREATE OR REPLACE FUNCTION public.refresh_sales_verification_store_comp_summary()
RETURNS void
LANGUAGE plpgsql
AS $function$
BEGIN
  TRUNCATE TABLE public.sales_verification_store_comp_summary;

  INSERT INTO public.sales_verification_store_comp_summary (
    company_entity_id,
    location_tag,
    as_of_date,
    py_as_of_date,
    min_day_date,
    max_day_date,
    row_count,
    blank_sku_rows,
    refund_discrepancy_rows,
    cur_day_qty,
    cur_day_net,
    cur_day_refunds,
    py_day_qty,
    py_day_net,
    py_day_refunds,
    cur_mtd_qty,
    cur_mtd_net,
    cur_mtd_refunds,
    py_mtd_qty,
    py_mtd_net,
    py_mtd_refunds,
    cur_ytd_qty,
    cur_ytd_net,
    cur_ytd_refunds,
    py_ytd_qty,
    py_ytd_net,
    py_ytd_refunds,
    day_net_var,
    day_net_var_pct,
    mtd_net_var,
    mtd_net_var_pct,
    ytd_net_var,
    ytd_net_var_pct,
    day_qty_var,
    day_qty_var_pct,
    mtd_qty_var,
    mtd_qty_var_pct,
    ytd_qty_var,
    ytd_qty_var_pct,
    refreshed_at
  )
  WITH max_day AS (
    SELECT
      company_entity_id,
      max(day_date)::date AS as_of_date
    FROM public.sales_by_day_verification_v
    WHERE company_entity_id IS NOT NULL
    GROUP BY company_entity_id
  ),
  periods AS (
    SELECT
      company_entity_id,
      as_of_date,
      (as_of_date - interval '1 year')::date AS py_as_of_date,
      date_trunc('month', as_of_date)::date AS cur_mtd_start,
      make_date(
        extract(year FROM (as_of_date - interval '1 year'))::int,
        extract(month FROM as_of_date)::int,
        1
      )::date AS py_mtd_start,
      date_trunc('year', as_of_date)::date AS cur_ytd_start,
      make_date(
        extract(year FROM (as_of_date - interval '1 year'))::int,
        1,
        1
      )::date AS py_ytd_start
    FROM max_day
  ),
  base AS (
    SELECT
      s.company_entity_id,
      s.location_tag,
      s.day_date::date AS day_date,
      coalesce(s.total_quantity_sold, 0)::numeric AS qty,
      coalesce(s.total_net_sales, 0)::numeric AS net_sales,
      coalesce(s.total_refunds, 0)::numeric AS refunds,
      CASE
        WHEN coalesce(trim(s.sku), '') = '' THEN 1
        ELSE 0
      END AS blank_sku_row,
      CASE
        WHEN lower(coalesce(s.product_name, '')) = '[refund discrepancy]'
          OR lower(coalesce(s.sku, '')) = '[refund discrepancy]'
        THEN 1
        ELSE 0
      END AS refund_discrepancy_row
    FROM public.sales_by_day_verification_v s
    WHERE s.company_entity_id IS NOT NULL
  ),
  location_dates AS (
    SELECT
      b.company_entity_id,
      b.location_tag,
      min(b.day_date) AS min_day_date,
      max(b.day_date) AS max_day_date,
      count(*) AS row_count,
      sum(b.blank_sku_row) AS blank_sku_rows,
      sum(b.refund_discrepancy_row) AS refund_discrepancy_rows
    FROM base b
    GROUP BY b.company_entity_id, b.location_tag
  ),
  day_cur AS (
    SELECT
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) AS cur_day_qty,
      sum(b.net_sales) AS cur_day_net,
      sum(b.refunds) AS cur_day_refunds
    FROM base b
    JOIN periods p
      ON p.company_entity_id = b.company_entity_id
    WHERE b.day_date = p.as_of_date
    GROUP BY b.company_entity_id, b.location_tag
  ),
  day_py AS (
    SELECT
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) AS py_day_qty,
      sum(b.net_sales) AS py_day_net,
      sum(b.refunds) AS py_day_refunds
    FROM base b
    JOIN periods p
      ON p.company_entity_id = b.company_entity_id
    WHERE b.day_date = p.py_as_of_date
    GROUP BY b.company_entity_id, b.location_tag
  ),
  mtd_cur AS (
    SELECT
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) AS cur_mtd_qty,
      sum(b.net_sales) AS cur_mtd_net,
      sum(b.refunds) AS cur_mtd_refunds
    FROM base b
    JOIN periods p
      ON p.company_entity_id = b.company_entity_id
    WHERE b.day_date BETWEEN p.cur_mtd_start AND p.as_of_date
    GROUP BY b.company_entity_id, b.location_tag
  ),
  mtd_py AS (
    SELECT
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) AS py_mtd_qty,
      sum(b.net_sales) AS py_mtd_net,
      sum(b.refunds) AS py_mtd_refunds
    FROM base b
    JOIN periods p
      ON p.company_entity_id = b.company_entity_id
    WHERE b.day_date BETWEEN p.py_mtd_start AND p.py_as_of_date
    GROUP BY b.company_entity_id, b.location_tag
  ),
  ytd_cur AS (
    SELECT
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) AS cur_ytd_qty,
      sum(b.net_sales) AS cur_ytd_net,
      sum(b.refunds) AS cur_ytd_refunds
    FROM base b
    JOIN periods p
      ON p.company_entity_id = b.company_entity_id
    WHERE b.day_date BETWEEN p.cur_ytd_start AND p.as_of_date
    GROUP BY b.company_entity_id, b.location_tag
  ),
  ytd_py AS (
    SELECT
      b.company_entity_id,
      b.location_tag,
      sum(b.qty) AS py_ytd_qty,
      sum(b.net_sales) AS py_ytd_net,
      sum(b.refunds) AS py_ytd_refunds
    FROM base b
    JOIN periods p
      ON p.company_entity_id = b.company_entity_id
    WHERE b.day_date BETWEEN p.py_ytd_start AND p.py_as_of_date
    GROUP BY b.company_entity_id, b.location_tag
  )
  SELECT
    ld.company_entity_id,
    ld.location_tag,
    p.as_of_date,
    p.py_as_of_date,
    ld.min_day_date,
    ld.max_day_date,
    ld.row_count,
    ld.blank_sku_rows,
    ld.refund_discrepancy_rows,

    coalesce(dc.cur_day_qty, 0),
    coalesce(dc.cur_day_net, 0),
    coalesce(dc.cur_day_refunds, 0),
    coalesce(dp.py_day_qty, 0),
    coalesce(dp.py_day_net, 0),
    coalesce(dp.py_day_refunds, 0),

    coalesce(mc.cur_mtd_qty, 0),
    coalesce(mc.cur_mtd_net, 0),
    coalesce(mc.cur_mtd_refunds, 0),
    coalesce(mp.py_mtd_qty, 0),
    coalesce(mp.py_mtd_net, 0),
    coalesce(mp.py_mtd_refunds, 0),

    coalesce(yc.cur_ytd_qty, 0),
    coalesce(yc.cur_ytd_net, 0),
    coalesce(yc.cur_ytd_refunds, 0),
    coalesce(yp.py_ytd_qty, 0),
    coalesce(yp.py_ytd_net, 0),
    coalesce(yp.py_ytd_refunds, 0),

    coalesce(dc.cur_day_net, 0) - coalesce(dp.py_day_net, 0),
    CASE
      WHEN coalesce(dp.py_day_net, 0) = 0 THEN NULL
      ELSE (coalesce(dc.cur_day_net, 0) - coalesce(dp.py_day_net, 0)) / nullif(dp.py_day_net, 0)
    END,

    coalesce(mc.cur_mtd_net, 0) - coalesce(mp.py_mtd_net, 0),
    CASE
      WHEN coalesce(mp.py_mtd_net, 0) = 0 THEN NULL
      ELSE (coalesce(mc.cur_mtd_net, 0) - coalesce(mp.py_mtd_net, 0)) / nullif(mp.py_mtd_net, 0)
    END,

    coalesce(yc.cur_ytd_net, 0) - coalesce(yp.py_ytd_net, 0),
    CASE
      WHEN coalesce(yp.py_ytd_net, 0) = 0 THEN NULL
      ELSE (coalesce(yc.cur_ytd_net, 0) - coalesce(yp.py_ytd_net, 0)) / nullif(yp.py_ytd_net, 0)
    END,

    coalesce(dc.cur_day_qty, 0) - coalesce(dp.py_day_qty, 0),
    CASE
      WHEN coalesce(dp.py_day_qty, 0) = 0 THEN NULL
      ELSE (coalesce(dc.cur_day_qty, 0) - coalesce(dp.py_day_qty, 0)) / nullif(dp.py_day_qty, 0)
    END,

    coalesce(mc.cur_mtd_qty, 0) - coalesce(mp.py_mtd_qty, 0),
    CASE
      WHEN coalesce(mp.py_mtd_qty, 0) = 0 THEN NULL
      ELSE (coalesce(mc.cur_mtd_qty, 0) - coalesce(mp.py_mtd_qty, 0)) / nullif(mp.py_mtd_qty, 0)
    END,

    coalesce(yc.cur_ytd_qty, 0) - coalesce(yp.py_ytd_qty, 0),
    CASE
      WHEN coalesce(yp.py_ytd_qty, 0) = 0 THEN NULL
      ELSE (coalesce(yc.cur_ytd_qty, 0) - coalesce(yp.py_ytd_qty, 0)) / nullif(yp.py_ytd_qty, 0)
    END,

    now()
  FROM location_dates ld
  JOIN periods p
    ON p.company_entity_id = ld.company_entity_id
  LEFT JOIN day_cur dc
    ON ld.company_entity_id = dc.company_entity_id
   AND ld.location_tag = dc.location_tag
  LEFT JOIN day_py dp
    ON ld.company_entity_id = dp.company_entity_id
   AND ld.location_tag = dp.location_tag
  LEFT JOIN mtd_cur mc
    ON ld.company_entity_id = mc.company_entity_id
   AND ld.location_tag = mc.location_tag
  LEFT JOIN mtd_py mp
    ON ld.company_entity_id = mp.company_entity_id
   AND ld.location_tag = mp.location_tag
  LEFT JOIN ytd_cur yc
    ON ld.company_entity_id = yc.company_entity_id
   AND ld.location_tag = yc.location_tag
  LEFT JOIN ytd_py yp
    ON ld.company_entity_id = yp.company_entity_id
   AND ld.location_tag = yp.location_tag
  ORDER BY ld.company_entity_id, ld.location_tag;
END;
$function$;

SELECT public.refresh_sales_verification_store_comp_summary();
