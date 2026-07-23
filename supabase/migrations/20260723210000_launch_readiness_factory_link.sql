-- Factory is a real selection on the PO (po_headers.factory_id) -- carry
-- that FK straight through to launch_product_readiness instead of only
-- carrying a free-text manufacturer label that has to be re-matched/re-cast
-- against the factories table on the other side. Mirrors expected_units,
-- which already flows through directly rather than being re-derived.
-- Safe to re-run.

alter table public.launch_product_readiness
  add column if not exists factory_id uuid references public.factories(id) on delete set null;

create index if not exists launch_product_readiness_factory_idx
  on public.launch_product_readiness (factory_id);

-- v_launch_po_product_lookup (used by Launch Calendar's "add from
-- Incoming/PO" search) only exposed factory_name as text. Add factory_id so
-- the real FK can be carried through instead of just the label.
-- New columns from CREATE OR REPLACE VIEW must be appended at the end of
-- the SELECT list -- Postgres treats inserting mid-list as a column rename,
-- not an addition (42P16).
create or replace view public.v_launch_po_product_lookup as
 SELECT h.id AS po_header_id,
    h.po_name,
    h.status AS po_status,
    h.order_date,
    h.req_ship_date,
    h.expected_arrival_date,
    h.date_bucket,
    h.is_new_product_po,
    h.wholesale_triggered,
    h.pdf_url,
    h.notes AS po_notes,
    h.internal_notes,
    f.factory_name,
    l.title_snapshot AS product_title,
    l.product_type_snapshot AS product_type,
    count(*) AS variant_count,
    sum(COALESCE(l.qty, 0))::integer AS total_units,
    sum(COALESCE(l.retail_value, COALESCE(l.qty, 0)::numeric * COALESCE(l.retail_price, 0::numeric))) AS total_retail_value,
    sum(COALESCE(l.qty, 0)::numeric * COALESCE(l.unit_cost, 0::numeric)) AS total_estimated_cost,
    min(l.retail_price) AS min_retail_price,
    max(l.retail_price) AS max_retail_price,
    string_agg(DISTINCT NULLIF(l.variant_title_snapshot, ''::text), ', '::text ORDER BY (NULLIF(l.variant_title_snapshot, ''::text))) AS variants,
    string_agg(DISTINCT NULLIF(l.sku_snapshot, ''::text), ', '::text ORDER BY (NULLIF(l.sku_snapshot, ''::text))) AS sample_skus,
    h.factory_id
   FROM po_lines l
     JOIN po_headers h ON h.id = l.po_header_id
     LEFT JOIN v_po_header_summary f ON f.id = h.id
  WHERE NULLIF(l.title_snapshot, ''::text) IS NOT NULL
  GROUP BY h.id, h.po_name, h.status, h.order_date, h.req_ship_date, h.expected_arrival_date, h.date_bucket, h.is_new_product_po, h.wholesale_triggered, h.pdf_url, h.notes, h.internal_notes, f.factory_name, l.title_snapshot, l.product_type_snapshot, h.factory_id;

-- CREATE OR REPLACE VIEW should preserve reloptions, but set explicitly to
-- be certain RLS keeps propagating through this view (see CLAUDE.md).
alter view public.v_launch_po_product_lookup set (security_invoker = true);
