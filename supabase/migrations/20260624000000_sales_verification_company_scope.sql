-- ============================================================
-- Sales verification + sales_by_day company isolation
--
-- 1. Backfill NULL company_entity_id on sales_by_day (Baseballism)
-- 2. Fix sales_verification_store_comp_summary PK for multi-tenant
-- 3. Rewrite refresh RPC to aggregate per company_entity_id
-- 4. RLS on sales_by_day via active_company_id()
-- ============================================================

-- Baseballism entity (Sheets / Better Reports sync)
DO $$
DECLARE
  v_baseballism uuid := '3bd934c9-4cdd-429b-9076-f8f6b45d4eb7';
BEGIN
  UPDATE public.sales_by_day
  SET company_entity_id = v_baseballism
  WHERE company_entity_id IS NULL;
END;
$$;

-- Summary table: PK was location_tag only — not tenant-safe
TRUNCATE TABLE public.sales_verification_store_comp_summary;

ALTER TABLE public.sales_verification_store_comp_summary
  DROP CONSTRAINT IF EXISTS sales_verification_store_comp_summary_pkey;

DROP INDEX IF EXISTS public.sales_verification_store_comp_summary_pkey;

ALTER TABLE public.sales_verification_store_comp_summary
  ALTER COLUMN company_entity_id SET NOT NULL;

ALTER TABLE public.sales_verification_store_comp_summary
  ADD CONSTRAINT sales_verification_store_comp_summary_pkey
  PRIMARY KEY (company_entity_id, location_tag);

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
    FROM public.sales_by_day
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
    FROM public.sales_by_day s
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

-- Repopulate summary with per-company rows
SELECT public.refresh_sales_verification_store_comp_summary();

-- sales_by_day: replace open read policies with active-company isolation
ALTER TABLE public.sales_by_day ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow authenticated read sales_by_day" ON public.sales_by_day;
DROP POLICY IF EXISTS "sales_by_day_select_authenticated" ON public.sales_by_day;
DROP POLICY IF EXISTS "sales_by_day_admin_all" ON public.sales_by_day;

CREATE POLICY "sales_by_day_active_select" ON public.sales_by_day
  FOR SELECT USING (company_entity_id = active_company_id());

CREATE POLICY "sales_by_day_active_write" ON public.sales_by_day
  FOR ALL
  USING    (company_entity_id = active_company_id() AND is_admin_user())
  WITH CHECK (company_entity_id = active_company_id() AND is_admin_user());
