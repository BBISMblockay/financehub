-- Measure launches through the products already attached to them.
--
-- The launch->PO link (see 20260826070000) is the strongest key, but it is
-- empty and only fills going forward. Meanwhile launch_product_readiness
-- already holds 138 manually-attached products across 21 launches, and that
-- chain reaches sales today with no tagging from anyone:
--
--   launch_product_readiness.product_title
--     -> products_master.product_title   (89% exact match)
--     -> products_master.sku             (77% of those reach sales_by_day)
--     -> sales_by_day                    (units + net sales in the window)
--
-- On joining by title: products_master is VARIANT-grained -- one row per
-- SKU, with product_title + variant_title -- and carries no product-level
-- id. product_title IS the product identity in this schema (it is what the
-- launch calendar's own picker groups by). So this is not a workaround for
-- a missing key; it is the key. The real fragility is that retitling a
-- product silently detaches its history, which is true of the catalog
-- generally.
--
-- Why not launch_calendar.product_sku: it is product-level and matches 0 of
-- sales_by_day's size-prefixed variant SKUs. Measured, not assumed.
--
-- Why not period lift (window sales vs trailing baseline): of 61 launches
-- exactly ONE has a non-overlapping window. See 20260826070000.

create index if not exists products_master_title_key_idx
  on public.products_master (lower(btrim(product_title)));
create index if not exists launch_product_readiness_title_key_idx
  on public.launch_product_readiness (lower(btrim(product_title)));

-- ── Launch x product grain ────────────────────────────────────────────
-- The grain a concept brief actually wants: which product in this launch
-- sold, not just the launch total.
create or replace view public.launch_product_sales_v as
with w as (
  select
    r.id                                            as readiness_id,
    r.launch_id,
    r.company_entity_id,
    r.product_title,
    r.product_type,
    r.expected_units,
    l.title                                         as launch_title,
    l.launch_date,
    l.launch_end_date,
    l.launch_date                                   as window_start,
    coalesce(l.launch_end_date, l.launch_date + 29) as window_end
  from public.launch_product_readiness r
  join public.launch_calendar l on l.id = r.launch_id
  where l.launch_date is not null
    and r.product_title is not null
    and btrim(r.product_title) <> ''
),
sku as (
  select distinct w.readiness_id, pm.sku
  from w
  join public.products_master pm
    on lower(btrim(pm.product_title)) = lower(btrim(w.product_title))
   and pm.company_entity_id = w.company_entity_id
  where pm.sku is not null
)
select
  w.readiness_id,
  w.launch_id,
  w.company_entity_id,
  w.launch_title,
  w.launch_date,
  w.launch_end_date,
  w.window_start,
  w.window_end,
  w.product_title,
  w.product_type,
  w.expected_units,
  count(distinct sku.sku)                                        as skus_matched,
  (count(distinct sku.sku) > 0)                                  as is_resolved,
  coalesce(sum(s.total_quantity_sold), 0)                        as units_sold,
  round(coalesce(sum(s.total_net_sales), 0), 2)                  as net_sales,
  round(coalesce(sum(s.total_gross_sales), 0), 2)                as gross_sales,
  coalesce(sum(s.total_orders), 0)                               as orders,
  -- Sell-through only means something when someone said what was expected.
  case when w.expected_units > 0
       then round(coalesce(sum(s.total_quantity_sold), 0)::numeric / w.expected_units, 4)
  end                                                            as pct_of_expected_units
from w
left join sku on sku.readiness_id = w.readiness_id
left join public.sales_by_day s
  on s.sku = sku.sku
 and s.company_entity_id = w.company_entity_id
 and s.day_date between w.window_start and w.window_end
group by w.readiness_id, w.launch_id, w.company_entity_id, w.launch_title,
         w.launch_date, w.launch_end_date, w.window_start, w.window_end,
         w.product_title, w.product_type, w.expected_units;

alter view public.launch_product_sales_v set (security_invoker = true);

comment on view public.launch_product_sales_v is
  'One row per product attached to a launch, with what those SKUs actually sold inside the launch window (launch_date through launch_end_date, or 30 days when no end date is set). Resolves products by title through products_master -- which is variant-grained, so product_title is the product identity here. is_resolved = false means the title matched nothing in the catalog, NOT that it sold nothing. A SKU can belong to more than one launch (refreshes, restocks), so these rows are correct per launch but will double-count if summed across launches. For an existing-product refresh this is sales during the window, not incremental lift.';

-- ── Launch grain ──────────────────────────────────────────────────────
create or replace view public.launch_product_actuals_v as
select
  p.launch_id,
  p.company_entity_id,
  p.launch_title,
  p.launch_date,
  p.launch_end_date,
  p.window_start,
  p.window_end,
  (p.window_end - p.window_start + 1)             as window_days,
  count(*)                                        as products_attached,
  count(*) filter (where p.is_resolved)           as products_resolved,
  round(count(*) filter (where p.is_resolved)::numeric
        / nullif(count(*), 0), 4)                 as resolution_rate,
  sum(p.skus_matched)                             as skus_matched,
  sum(p.units_sold)                               as units_sold,
  round(sum(p.net_sales), 2)                      as net_sales,
  round(sum(p.gross_sales), 2)                    as gross_sales,
  sum(p.orders)                                   as orders,
  sum(p.expected_units)                           as expected_units,
  case when sum(p.expected_units) > 0
       then round(sum(p.units_sold)::numeric / sum(p.expected_units), 4)
  end                                             as pct_of_expected_units,
  -- Partial resolution is the quiet failure mode: a launch whose titles
  -- mostly missed the catalog looks like a weak launch instead of an
  -- unmeasured one. Say which it is.
  case
    when count(*) = 0 then 'no products attached'
    when count(*) filter (where p.is_resolved) = 0 then
      'none of the attached product titles matched the catalog -- not measured, not zero'
    when count(*) filter (where p.is_resolved) < count(*) then
      'partial: ' || count(*) filter (where p.is_resolved) || ' of ' || count(*) ||
      ' product titles matched the catalog; totals cover only those'
    else 'all attached products resolved'
  end                                             as resolution_note
from public.launch_product_sales_v p
group by p.launch_id, p.company_entity_id, p.launch_title, p.launch_date,
         p.launch_end_date, p.window_start, p.window_end;

alter view public.launch_product_actuals_v set (security_invoker = true);

comment on view public.launch_product_actuals_v is
  'What a launch actually sold, measured through the products attached to it in launch_product_readiness. Available today for launches with attached products -- unlike launch_actuals_v, which needs launch_calendar.linked_po_id and currently has none. ALWAYS read resolution_note alongside the totals: a launch whose product titles did not match the catalog reports low numbers because it was not measured, not because it sold little. Do not sum net_sales across launches -- a SKU can belong to several.';

-- ── Fold product-based measurement into the measurability report ──────
-- Recreated rather than replaced: new columns land mid-list, and
-- create-or-replace cannot reorder a view's columns.
drop view if exists public.launch_measurability_v;

create view public.launch_measurability_v as
with base as (
  select
    l.id, l.company_entity_id, l.title, l.launch_date, l.launch_end_date,
    l.launch_type, l.product_title, l.po_number, l.linked_po_id,
    l.launch_date                                   as window_start,
    coalesce(l.launch_end_date, l.launch_date + 13) as window_end
  from public.launch_calendar l
  where l.launch_date is not null
),
counted as (
  select b.*,
    (select count(*) from base o
      where o.id <> b.id
        and o.company_entity_id = b.company_entity_id
        and o.window_start <= b.window_end
        and o.window_end   >= b.window_start) as overlapping_launches,
    (select count(*) from public.launch_product_readiness r
      where r.launch_id = b.id)               as products_attached,
    (select coalesce(a.products_resolved, 0) from public.launch_product_actuals_v a
      where a.launch_id = b.id)               as products_resolved
  from base b
)
select
  c.id, c.company_entity_id, c.title, c.launch_date, c.launch_end_date,
  c.launch_type, c.product_title, c.po_number, c.linked_po_id,
  c.window_start, c.window_end,
  (c.window_end - c.window_start + 1)          as window_days,
  (c.launch_date <= current_date)              as has_happened,
  (c.linked_po_id is not null)                 as is_linked,
  c.overlapping_launches,
  c.products_attached,
  c.products_resolved,
  h.po_name, h.is_new_product_po, h.expected_arrival_date,
  (select count(*)    from public.po_lines pl where pl.po_header_id = c.linked_po_id) as po_line_count,
  (select sum(pl.qty) from public.po_lines pl where pl.po_header_id = c.linked_po_id) as po_units,
  case
    when c.linked_po_id is not null           then 'measurable_by_po'
    when coalesce(c.products_resolved,0) > 0  then 'measurable_by_products'
    when c.overlapping_launches = 0           then 'estimable_by_period'
    else 'not_measurable'
  end as measurability,
  case
    when c.linked_po_id is not null then null
    when coalesce(c.products_resolved,0) > 0 then
      'Measured through ' || c.products_resolved || ' attached product(s) -- see launch_product_actuals_v. Linking a PO would make it exact.'
    when c.products_attached > 0 then
      'Products are attached but none of their titles matched the catalog, so nothing resolves. Check the titles against products_master.'
    when c.overlapping_launches = 0 then
      'No PO and no products attached. Window is clean, so period-over-period is directionally usable, but it is an estimate, not attribution.'
    else
      'No PO, no products attached, and ' || c.overlapping_launches ||
      ' other launch(es) share this window -- period comparison cannot separate them. Attach products or link a PO.'
  end as measurability_note
from counted c
left join public.po_headers h on h.id = c.linked_po_id;

alter view public.launch_measurability_v set (security_invoker = true);

comment on view public.launch_measurability_v is
  'Per launch: whether its performance can be measured, and why not when it cannot. measurability = measurable_by_po (linked_po_id set, use launch_actuals_v), measurable_by_products (products attached and resolved to the catalog, use launch_product_actuals_v), estimable_by_period (neither, but a clean non-overlapping window), or not_measurable. NEVER estimate a launch from total sales in its window without checking overlapping_launches -- launches here overlap heavily and that comparison is usually meaningless and sometimes inverted. Filter has_happened = true and measurability = not_measurable for the tagging worklist.';

-- Teach Ask SILO the new views, including the misreading to avoid.
select public.refresh_chat_schema_catalog();

update public.silo_chat_schema_catalog set
  description = case relname
    when 'launch_product_actuals_v' then 'What a launch actually sold, measured through the products attached to it in launch_product_readiness (resolved to the catalog by product title). This is the view to use for "how did that launch do" today. ALWAYS read resolution_note with the totals: a launch whose product titles did not match the catalog shows low numbers because it was not measured, not because it sold little. Never sum net_sales across launches -- a SKU can belong to several.'
    when 'launch_product_sales_v' then 'One row per product attached to a launch with what those SKUs sold in the launch window. The grain for "which product in this launch sold". is_resolved = false means the title matched nothing in the catalog, not that it sold nothing.'
    else description end,
  keywords = case relname
    when 'launch_product_actuals_v' then array['launch performance','how did the launch do','launch sales','launch results','drop performance','units sold launch']
    when 'launch_product_sales_v' then array['launch product sales','which product sold','product in launch','launch sku performance']
    else keywords end
where relname in ('launch_product_actuals_v','launch_product_sales_v');
