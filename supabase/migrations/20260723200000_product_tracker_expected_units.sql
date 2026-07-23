-- Pipeline items (product_tracker) are frequently auto-created straight from
-- a PO line (po-builder.html's autoSyncLineToTracker, for "new product" POs)
-- but had no column to hold the line's quantity -- it was read off the PO
-- line and then discarded. Adds expected_units so it can be captured at
-- creation time, edited on the Products page, and kept in sync with
-- launch_product_readiness.expected_units when a Pipeline item is linked to
-- a launch.
-- Safe to re-run.

alter table public.product_tracker
  add column if not exists expected_units integer;
