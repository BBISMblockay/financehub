-- Product samples: add workflow date stamps + product link snapshot
-- Safe to re-run.

alter table public.product_samples
  add column if not exists received_at        date,
  add column if not exists sent_at            date,
  add column if not exists warehouse_ready_at date,
  add column if not exists picked_up_at       date,
  add column if not exists photo_received_at  date,
  add column if not exists product_title_snapshot text;  -- denorm from linked product
