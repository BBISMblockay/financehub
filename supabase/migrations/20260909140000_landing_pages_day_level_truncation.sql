-- Put the DAY-level truncation figure in the catalog, because the model
-- keeps deriving the row-level one and restating it as a rate over time.
--
-- Observed live 2026-09-09 (silo_chat_audit_log 13820e92): asked about the
-- lowest-traffic landing pages, Ask SILO computed 10,553/10,757 itself and
-- wrote that the table "truncates 98% of the time". That is a ROW share
-- described as a TIME share, and it is wrong: a capped day contributes 250
-- rows while a POS shop's day contributes one, so the row share is dragged
-- up by exactly the days that hit the cap. The real day figures are 42 of
-- 236 shop-days overall, and 42 of 42 -- every day -- for
-- baseballism.myshopify.com, the only shop with meaningful web traffic.
--
-- Nothing told it 98%; it derived that from the data's own shape, which is
-- why the fix belongs here rather than in a prompt rule. The same
-- conflation was caught in this repo's own migration comment during review
-- of PR #631, so it is not a model quirk -- it is a trap the shape of this
-- table sets for any reader.
--
-- Description only. No schema change.

update public.silo_chat_schema_catalog
set description =
  'Sessions and funnel counts per landing page path per day, from ShopifyQL. '
  'TOP-N SLICE, NOT A COMPLETE LIST: only about the top 250 paths per day are '
  'stored (is_truncated marks a day that hit the cap; rank_in_day gives the '
  'position), so it must never be summed as total sessions -- use '
  'shopify_sessions_daily for totals. HOW OFTEN IT TRUNCATES, IN DAYS: for '
  'baseballism.myshopify.com, the only shop with meaningful web traffic, EVERY '
  'day recorded so far hit the cap (42 of 42 as of 2026-09-09); the ~17 '
  'retail/popup shops never do, at 1-2 paths a day. Do NOT compute this from '
  'the row counts and state it as a rate over time -- 98% of ROWS carry '
  'is_truncated, but that is 42 of 236 shop-DAYS, because a capped day '
  'contributes 250 rows and a POS day contributes one. ABSENCE IS NOT '
  'NONEXISTENCE: a path missing here had no recorded landing traffic in the '
  'retained slice, which is NOT evidence the page or collection does not '
  'exist -- shopify_collections is the registry for that question, and only '
  'when it has a completed recent run in shopify_collection_sync_runs. Check '
  'min(day_date) before describing a window: history is far shorter than the '
  'sync window suggests. Good for which pages get traffic and which convert.',
    updated_at = now()
where relname = 'shopify_landing_pages_daily';
