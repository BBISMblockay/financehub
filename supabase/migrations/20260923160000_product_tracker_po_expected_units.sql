-- Pipeline items auto-added from a PO: record which PO, and correct Expected
-- Units to that PO's total across every size line.
--
-- /v2/po-builder.html used to sync a new-product PO into product_tracker one
-- LINE at a time, on line save only, writing that one line's qty into
-- expected_units. A Pipeline item is one PRODUCT and a PO carries one line
-- per SIZE, so whichever size was saved last won: Incotexco-496's
-- "Elevate & Celebrate T-Shirt - Youth" reads 105 (its YXL line) instead of
-- 550 (95 + 180 + 170 + 105), and the adult tee reads 10 (3XL) instead of 325.
-- It never recorded po_header_id either (the column arrived in
-- 20260915230000), so nothing ties these items to their PO except the note
-- the sync left: "Auto-added from PO: <po_name>".
--
-- The page now syncs the whole PO (v2/po-pipeline-sync.js). This fixes what
-- the old sync already wrote. Measured against production 2026-09-23:
-- 182 auto-added items, none linked; 159 whose note names exactly one PO in
-- their company that carries lines with their title; 49 of those whose figure
-- is the bug's fingerprint (null, or exactly one of that product's line
-- quantities on that PO) and differs from the PO total; 22 launch readiness
-- rows paired with those 49 and carrying the same wrong figure.
--
-- What it touches, and what it deliberately does not:
--   * Only items still UNLINKED (po_header_id is null) whose note names a PO.
--     Every candidate is linked by this migration, so a second run finds
--     nothing: it converges after one pass and never revisits an item a
--     person has edited since.
--   * The PO must resolve to EXACTLY ONE po_headers row (case-insensitive --
--     the notes spell KCMTar-34 where the PO is KCMTAR-34) in the item's own
--     company, and carry lines with the item's title. Anything else is left
--     unlinked rather than guessed at.
--   * expected_units is replaced only when the stored figure is null or is
--     exactly one of the product's line quantities on that PO -- what the old
--     sync could have written. 2 linked items hold some other number (600
--     against a 300-unit PO, 205 against 2,000) and are linked but keep it.
--   * A launch_product_readiness row paired with a corrected item is updated
--     only where it holds the same figure the item held, i.e. the copy the
--     Pipeline drawer's save made. A figure typed on the Launch Calendar is
--     left alone.
--   * Totals are lower(trim(title)) matched, the same key the July backfill
--     (20260723230000) and the page use. A total of 0 is never written.
--
-- Safe to re-run.

with auto as (
  select pt.id, pt.company_entity_id, pt.product_title, pt.expected_units,
         trim(substring(pt.notes from '(?i)^\s*(?:auto-added|pushed) from po:\s*([^\n]*)')) as noted_po
  from public.product_tracker pt
  where pt.po_header_id is null
    and pt.notes ~* '^\s*(auto-added|pushed) from po:'
),
resolved as (
  select a.*, (array_agg(h.id))[1] as po_id, count(h.id) as n_po
  from auto a
  join public.po_headers h
    on lower(h.po_name) = lower(a.noted_po)
   and h.company_entity_id = a.company_entity_id
  where coalesce(a.noted_po, '') <> ''
  group by a.id, a.company_entity_id, a.product_title, a.expected_units, a.noted_po
),
totals as (
  select r.id, r.company_entity_id, r.po_id, r.expected_units as old_units,
         sum(coalesce(l.qty, 0))::integer as po_total,
         array_agg(l.qty::integer) as line_qtys
  from resolved r
  join public.po_lines l
    on l.po_header_id = r.po_id
   and lower(trim(l.title_snapshot)) = lower(trim(r.product_title))
  where r.n_po = 1
  group by r.id, r.company_entity_id, r.po_id, r.expected_units
),
plan as (
  select t.*,
         (t.po_total > 0
          and t.po_total is distinct from t.old_units
          and (t.old_units is null or t.old_units = any(t.line_qtys))) as fix_units
  from totals t
),
linked as (
  update public.product_tracker pt
     set po_header_id   = p.po_id,
         expected_units = case when p.fix_units then p.po_total else pt.expected_units end
    from plan p
   where pt.id = p.id
     and pt.po_header_id is null
  returning pt.id
)
update public.launch_product_readiness lpr
   set expected_units = p.po_total
  from plan p
 where p.fix_units
   and lpr.product_tracker_id = p.id
   and lpr.company_entity_id = p.company_entity_id
   and lpr.expected_units is not distinct from p.old_units
   -- the item this copies from must actually have been linked above
   and exists (select 1 from linked k where k.id = p.id);
