-- One-time backfill: 200 of 208 existing product_tracker rows match a real
-- po_lines.title_snapshot (exact, case-insensitive) but were created before
-- factory_id/expected_units were reliably captured (or before
-- expected_units existed at all -- see 20260723200000). Real factory/type/
-- ETA/qty data already exists on the matching PO; only overwrite currently-
-- blank fields, never anything already set.
-- Safe to re-run (idempotent once converged).

with matched as (
  select
    pt.id as tracker_id,
    (array_agg(h.factory_id order by h.order_date desc nulls last, h.created_at desc) filter (where h.factory_id is not null))[1] as factory_id,
    (array_agg(l.product_type_snapshot order by h.order_date desc nulls last, h.created_at desc) filter (where l.product_type_snapshot is not null and l.product_type_snapshot <> ''))[1] as product_type,
    (array_agg(h.expected_arrival_date order by h.order_date desc nulls last, h.created_at desc) filter (where h.expected_arrival_date is not null))[1] as bulk_eta,
    sum(coalesce(l.qty,0)) as total_qty
  from public.product_tracker pt
  join public.po_lines l on lower(trim(l.title_snapshot)) = lower(trim(pt.product_title))
  join public.po_headers h on h.id = l.po_header_id
  group by pt.id
)
update public.product_tracker pt
set
  factory_id = coalesce(pt.factory_id, matched.factory_id),
  manufacturer = coalesce(pt.manufacturer, f.factory_name),
  product_type = coalesce(nullif(pt.product_type,''), matched.product_type),
  bulk_eta = coalesce(pt.bulk_eta, matched.bulk_eta),
  expected_units = coalesce(pt.expected_units, nullif(matched.total_qty,0))
from matched
left join public.factories f on f.id = matched.factory_id
where matched.tracker_id = pt.id
  and (pt.factory_id is null or pt.product_type is null or pt.product_type='' or pt.bulk_eta is null or pt.expected_units is null or pt.manufacturer is null);
