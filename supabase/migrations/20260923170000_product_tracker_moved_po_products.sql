-- Pipeline items the first correction (20260923160000) could not reach: a
-- product whose figure came from a DIFFERENT PO, and items whose note names
-- a PO that no longer carries the product.
--
-- The old PO Builder sync matched a Pipeline item by TITLE ONLY, across every
-- new-product PO. So when one product sat on two POs, a line saved on either
-- overwrote the one item: "The Kid Youth T-Shirt - Baseballism x Ken Griffey
-- Jr." was created from KCMTar-48 (2,000 units) and reads 205 -- the YXL line
-- of KCMTAR-49. 20260923160000 only recognised a line quantity of the item's
-- OWN PO as the bug, so it linked this item and kept the 205.
--
-- Separately, a PO is recreated when its factory changes (the name comes from
-- the factory), so a note can name a PO that no longer carries the product:
-- "Auto-added from PO: Creytex-335" on hoodies now ordered on
-- ShaoxingTianyun-111. 20260923160000 could not resolve those, and the page's
-- claim rule refused them because the note names another PO -- fixed in
-- v2/po-pipeline-sync.js alongside this, which now looks the noted PO up.
--
-- Measured against production 2026-09-23, after 20260923160000:
--   Part 1  1 linked item holding another new-product PO's line quantity and
--           none of its own PO's: 205 -> 2,000, plus 1 launch readiness copy.
--   Part 2  16 unlinked auto-added items whose noted PO does not carry the
--           product, where exactly ONE new-product PO does. All 16 are linked
--           to it; 5 hold a line quantity of that product (160 -> 610,
--           110 -> 405, 285 -> 1,500, 35 -> 300, 90 -> 300) and are corrected,
--           plus 2 launch readiness copies; 11 already equal the PO total.
--   Left alone: 7 unlinked items no new-product PO carries (renamed or
--   mistyped titles), and "Bsblism Athletics (Attack the Baseball) Cap -
--   Youth" at 600 against MasterCap-80's 300 -- 600 is a line on no PO.
--
-- Rules, same as 20260923160000 and for the same reasons:
--   * The bug's fingerprint is a figure that is null or exactly one size line
--     of the same product -- here on ANY new-product PO in the company, since
--     that is how far the old sync reached. Nothing else is overwritten.
--   * A launch_product_readiness row follows only where it holds the figure
--     the item held.
--   * Titles match on lower(trim()); a total of 0 is never written.
-- Safe to re-run: Part 2 only touches unlinked items and links every one it
-- touches; Part 1 only touches a figure that is some other PO's line and none
-- of the item's own, which a corrected item (its own PO total) never is.

-- ── Part 1: linked items holding another PO's line ─────────────────────────
with lines as (
  select h.company_entity_id, h.id as po_id, h.is_new_product_po as np,
         lower(trim(l.title_snapshot)) as k, coalesce(l.qty, 0) as qty
  from public.po_lines l
  join public.po_headers h on h.id = l.po_header_id
),
plan as (
  select pt.id, pt.company_entity_id, pt.expected_units as old_units,
         (select sum(x.qty) from lines x
           where x.po_id = pt.po_header_id and x.k = lower(trim(pt.product_title)))::integer as po_total
  from public.product_tracker pt
  where pt.po_header_id is not null
    and pt.notes ~* '^\s*(auto-added|pushed) from po:'
    and pt.expected_units is not null
    and exists (select 1 from lines x
                 where x.company_entity_id = pt.company_entity_id and x.np
                   and x.po_id <> pt.po_header_id
                   and x.k = lower(trim(pt.product_title)) and x.qty = pt.expected_units)
    and not exists (select 1 from lines x
                     where x.po_id = pt.po_header_id
                       and x.k = lower(trim(pt.product_title)) and x.qty = pt.expected_units)
),
fixed as (
  update public.product_tracker pt
     set expected_units = p.po_total
    from plan p
   where pt.id = p.id
     and p.po_total > 0
     and pt.expected_units is distinct from p.po_total
  returning pt.id
)
update public.launch_product_readiness lpr
   set expected_units = p.po_total
  from plan p
 where lpr.product_tracker_id = p.id
   and lpr.company_entity_id = p.company_entity_id
   and lpr.expected_units is not distinct from p.old_units
   and exists (select 1 from fixed f where f.id = p.id);

-- ── Part 2: unlinked items whose noted PO no longer carries the product ────
with lines as (
  select h.company_entity_id, h.id as po_id, h.po_name, h.is_new_product_po as np,
         lower(trim(l.title_snapshot)) as k, coalesce(l.qty, 0) as qty
  from public.po_lines l
  join public.po_headers h on h.id = l.po_header_id
),
cand as (
  select pt.id, pt.company_entity_id, pt.product_title, pt.expected_units as old_units,
         trim(substring(pt.notes from '(?i)^\s*(?:auto-added|pushed) from po:\s*([^\n]*)')) as noted_po
  from public.product_tracker pt
  where pt.po_header_id is null
    and pt.notes ~* '^\s*(auto-added|pushed) from po:'
),
movable as (
  select c.*, t.po_id as target_po
  from cand c
  join lateral (
    select (array_agg(distinct x.po_id))[1] as po_id, count(distinct x.po_id) as n
    from lines x
    where x.company_entity_id = c.company_entity_id and x.np and x.k = lower(trim(c.product_title))
  ) t on t.n = 1
  -- the noted PO must NOT still carry the product; if it does, it owns it
  where not exists (select 1 from lines x
                     where x.company_entity_id = c.company_entity_id
                       and x.k = lower(trim(c.product_title))
                       and lower(x.po_name) = lower(coalesce(c.noted_po, '')))
),
plan as (
  select m.*,
         (select sum(x.qty) from lines x
           where x.po_id = m.target_po and x.k = lower(trim(m.product_title)))::integer as po_total,
         exists (select 1 from lines x
                  where x.company_entity_id = m.company_entity_id and x.np
                    and x.k = lower(trim(m.product_title)) and x.qty = m.old_units) as is_a_line
  from movable m
),
decided as (
  select p.*,
         (p.po_total > 0
          and p.po_total is distinct from p.old_units
          and (p.old_units is null or p.is_a_line)) as fix_units
  from plan p
),
linked as (
  update public.product_tracker pt
     set po_header_id   = d.target_po,
         expected_units = case when d.fix_units then d.po_total else pt.expected_units end
    from decided d
   where pt.id = d.id
     and pt.po_header_id is null
  returning pt.id
)
update public.launch_product_readiness lpr
   set expected_units = d.po_total
  from decided d
 where d.fix_units
   and lpr.product_tracker_id = d.id
   and lpr.company_entity_id = d.company_entity_id
   and lpr.expected_units is not distinct from d.old_units
   and exists (select 1 from linked k where k.id = d.id);
