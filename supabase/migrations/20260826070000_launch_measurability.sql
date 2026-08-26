-- Which launches can actually be measured, and which cannot.
--
-- Background: launch_actuals_v resolves a launch's real SKUs only through
-- linked_po_id -> po_lines.sku_snapshot. As of this migration, 0 of 61
-- launches have linked_po_id set -- not because anyone skipped the field,
-- but because no page has ever written it. The launch calendar's PO picker
-- held the PO's uuid and saved only its NAME as text, discarding the
-- relationship at the moment it was created. That is fixed in the same
-- change as this migration.
--
-- Why not measure launches by period lift instead (sales in the launch
-- window vs a trailing baseline)? Because it cannot work for this business.
-- Measured across all 61 launches, exactly ONE has a window that does not
-- overlap another launch; the rest overlap between 1 and 15 others. With
-- that density there is no clean baseline anywhere, and the metric inverts:
-- a launch that follows a big event scores terribly because its baseline
-- window contains that event's surge. Overlapping launches can only be
-- separated by WHICH SKUS SOLD, never by time -- which is precisely what
-- linked_po_id makes possible and nothing else does.
--
-- So this view does not estimate. It reports whether each launch is
-- measurable, and surfaces the unlinked ones as a worklist.

create or replace view public.launch_measurability_v as
with base as (
  select
    l.id,
    l.company_entity_id,
    l.title,
    l.launch_date,
    l.launch_end_date,
    l.launch_type,
    l.product_title,
    l.po_number,
    l.linked_po_id,
    l.launch_date                                        as window_start,
    coalesce(l.launch_end_date, l.launch_date + 13)      as window_end
  from public.launch_calendar l
  where l.launch_date is not null
),
counted as (
  select b.*,
    (select count(*) from base o
      where o.id <> b.id
        and o.company_entity_id = b.company_entity_id
        and o.window_start <= b.window_end
        and o.window_end   >= b.window_start) as overlapping_launches
  from base b
)
select
  c.id,
  c.company_entity_id,
  c.title,
  c.launch_date,
  c.launch_end_date,
  c.launch_type,
  c.product_title,
  c.po_number,
  c.linked_po_id,
  c.window_start,
  c.window_end,
  (c.window_end - c.window_start + 1)          as window_days,
  (c.launch_date <= current_date)              as has_happened,
  (c.linked_po_id is not null)                 as is_linked,
  c.overlapping_launches,
  h.po_name,
  h.is_new_product_po,
  h.expected_arrival_date,
  -- Units/SKUs the linked PO actually covers -- the basis for any real
  -- measurement of this launch.
  (select count(*)             from public.po_lines pl where pl.po_header_id = c.linked_po_id) as po_line_count,
  (select sum(pl.qty)          from public.po_lines pl where pl.po_header_id = c.linked_po_id) as po_units,
  case
    when c.linked_po_id is not null then 'measurable'
    -- Kept as a category rather than dropped, but it describes almost
    -- nothing today: exactly one launch in the calendar qualifies.
    when c.overlapping_launches = 0 then 'estimable_by_period'
    else 'not_measurable'
  end as measurability,
  case
    when c.linked_po_id is not null then null
    when c.overlapping_launches = 0 then
      'No PO linked. Window is clean, so period-over-period is directionally usable, but it is an estimate, not attribution.'
    else
      'No PO linked, and ' || c.overlapping_launches ||
      ' other launch(es) share this window -- period comparison cannot separate them. Link a PO to measure this launch.'
  end as measurability_note
from counted c
left join public.po_headers h on h.id = c.linked_po_id;

alter view public.launch_measurability_v set (security_invoker = true);

comment on view public.launch_measurability_v is
  'Per launch: whether it can be measured, and why not when it cannot. measurability is "measurable" (linked_po_id set -- use launch_actuals_v for real SKU-level results), "estimable_by_period" (no PO but a non-overlapping window), or "not_measurable" (no PO and overlapping launches). Filter is_linked = false and has_happened = true for the tagging worklist. Do NOT estimate launch performance from sales in the launch window without checking overlapping_launches -- at this calendar density the comparison is usually meaningless and sometimes inverted.';

-- Teach Ask SILO what this is, and specifically what NOT to do with it --
-- a new object gets auto-discovered columns but no meaning, and the
-- dangerous mistake here (estimating a launch from window sales) is exactly
-- the one a model would otherwise make.
select public.refresh_chat_schema_catalog();

update public.silo_chat_schema_catalog
set description = 'Per launch: whether its performance can actually be measured. measurability = measurable (a PO is linked, so launch_actuals_v gives real SKU-level results), estimable_by_period (no PO but a clean non-overlapping window), or not_measurable (no PO and overlapping launches). IMPORTANT: never estimate a launch''s performance from total sales in its date window without checking overlapping_launches -- launches here overlap heavily and that comparison is usually meaningless and sometimes inverted. Filter is_linked = false and has_happened = true for the PO-tagging worklist.',
    keywords = array['launch performance','launch measurable','did the launch work','linked po','launch attribution','tagging worklist','launch overlap']
where relname = 'launch_measurability_v';
