-- Affiliate codes: record turning a code off in Shopify (audit 2026-11-18).
--
-- Ending an affiliate or retiring a code changed SILO only; the discount kept
-- working at checkout. affiliate-invite's end_shopify_codes action now
-- deactivates the Shopify discount (by the id SILO stored when it made it)
-- and writes the outcome here, so "turned off", "could not" and "not tried"
-- are three different records:
--   shopify_ended_at   when Shopify confirmed the discount is off (or gone)
--   shopify_end_error  why the last attempt did not, cleared on success
-- Additive and nullable; existing rows read as "not tried".

alter table public.affiliate_codes add column if not exists shopify_ended_at timestamptz;
alter table public.affiliate_codes add column if not exists shopify_end_error text;

comment on column public.affiliate_codes.shopify_ended_at is
  'When SILO turned this retired code off in Shopify (discountCodeDeactivate), or found it already gone. Null = not turned off by SILO (20261119050000).';
comment on column public.affiliate_codes.shopify_end_error is
  'Why the last attempt to turn this code off in Shopify failed; null after it succeeds (20261119050000).';
