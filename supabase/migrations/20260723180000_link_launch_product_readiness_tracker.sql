-- Link product_tracker (Products page Pipeline tab) and launch_product_readiness
-- (Launch Calendar's Products tab) together. These grew as two independent,
-- largely-duplicate tables for the same "is this product launch-ready"
-- concept -- neither ever referenced the other, so linking a product to a
-- launch on one screen never showed up on the other, and qty/status edits
-- never flowed between them. This adds the FK the app now uses to keep a
-- launch_product_readiness row and its paired product_tracker row in sync
-- on save from either screen.
-- Safe to re-run.

alter table public.launch_product_readiness
  add column if not exists product_tracker_id uuid references public.product_tracker(id) on delete set null;

create index if not exists launch_product_readiness_tracker_idx
  on public.launch_product_readiness (product_tracker_id);
