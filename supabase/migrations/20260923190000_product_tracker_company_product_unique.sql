-- One LINKED Pipeline item per product per COMPANY, not per PO.
--
-- 20260923180000 keyed the guard on (po_header_id, title). That stops two
-- tabs syncing the SAME PO from each adding an item, but the invariant
-- v2/po-pipeline-sync.js actually works to is one Pipeline item per product:
-- when another PO already owns a product, a PO leaves that item alone rather
-- than adding its own. Two POs carrying one product -- KCMTar-48 and
-- KCMTAR-49 both carry the Ken Griffey Jr. youth tee -- synced at the same
-- moment could each read the Pipeline, each find no item, and each insert one:
-- different PO ids, so the per-PO index let both land, and every later sync
-- then preferred each PO's own row, so the duplicate never healed. (Found in
-- the second independent review of PR #769, reproduced against the committed
-- index.)
--
-- So the key is the company and the product. The second insert, or a claim of
-- an unlinked item while another PO has just linked one, now fails with 23505,
-- and the sync re-reads the linked item that won: its own PO's is brought in
-- step, another PO's is left alone.
--
-- Scope:
--   * Only LINKED items (po_header_id is not null), as before. Items a person
--     typed into the Pipeline with no PO are unaffected.
--   * It also covers a hand edit: linking a second item for a product to a
--     PO in the Pipeline drawer is refused while another linked item exists
--     (/v2/products.html names the rule). 0 such pairs exist.
--   * company_entity_id is nullable, but the stamp_company_entity_id trigger
--     fills it on insert and no row has it null (measured below).
--   * The per-PO index is implied by this one (a PO belongs to one company:
--     0 items linked to a PO of another company), so it is dropped rather
--     than left as a second definition of the same rule.
--
-- Measured on production 2026-09-23 before creating it: 286 rows, 0 groups
-- that would violate it, 0 rows with a null company, 0 items linked to a PO
-- of another company. Reversible: recreate product_tracker_po_product_uniq
-- (20260923180000) and drop this index. Safe to re-run.

create unique index if not exists product_tracker_company_product_uniq
  on public.product_tracker (company_entity_id, lower(btrim(product_title)))
  where po_header_id is not null;

comment on index public.product_tracker_company_product_uniq is
  'One linked Pipeline item per product per company. v2/po-pipeline-sync.js relies on this: two tabs, or two POs carrying the same product, cannot both add an item; a 23505 makes the sync re-read the linked item that won (its own PO''s is updated, another PO''s left alone).';

drop index if exists public.product_tracker_po_product_uniq;
