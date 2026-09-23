-- One Pipeline item per product per PO, enforced by the database.
--
-- v2/po-pipeline-sync.js coalesces overlapping syncs of a PO inside ONE
-- browser tab. Two tabs, or two people saving the same new-product PO, could
-- each read the Pipeline, each find no item for a product, and each insert
-- one -- a duplicate item with the same PO and title. (Found in independent
-- review of PR #769; the unit suite's own race test showed two rows.)
--
-- A partial unique index on (po_header_id, lower(btrim(product_title))) makes
-- the second insert fail with 23505; the sync then re-reads the item that won
-- and brings it in step instead. It also refuses the claim-side race: linking
-- an unlinked item to a PO that already has an item for that product.
--
-- Scope, deliberately narrow:
--   * Only LINKED items (po_header_id is not null). Items a person typed into
--     the Pipeline with no PO keep behaving as before, duplicates included --
--     title uniqueness across the whole Pipeline is a different decision.
--   * The key is the PO, not the company: a PO belongs to one company.
--   * lower(btrim()) is the same key the page (titleKey) and the two data
--     migrations (20260923160000, 20260923170000) match on.
--
-- Measured on production 2026-09-23 before creating it: 286 rows, 0 groups
-- that would violate it. Additive and reversible (drop index). Safe to re-run.

create unique index if not exists product_tracker_po_product_uniq
  on public.product_tracker (po_header_id, lower(btrim(product_title)))
  where po_header_id is not null;

comment on index public.product_tracker_po_product_uniq is
  'One Pipeline item per product per PO. v2/po-pipeline-sync.js relies on this to stop two tabs adding the same item; a 23505 makes it re-read and update the item that won.';
