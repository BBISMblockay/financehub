-- 20260910150000_restore_lost_catalog_caveats.sql
-- ---------------------------------------------------------------------------
-- Two Ask SILO catalog caveats were lost, each by a later migration that
-- rewrote the whole description with `set description = '...'` instead of
-- appending. Found by the FIRST scheduled run of deployment-drift-check.yml
-- (2026-09-10), not by a person -- the two verify checks that guard them had
-- been reporting MISSING since the rewrites and nobody ran the script.
--
--   marketing_kpis_daily        'CLAIMED, NOT ACTUAL' (20260827180000) was
--                               dropped by 20260908150000, which replaced the
--                               description to add the grain caveat.
--   shopify_landing_pages_daily 'ABSENCE IS NOT NONEXISTENCE' (20260908150000,
--                               the SEO project's step 1) was dropped the NEXT
--                               DAY by 20260909140000 and again by
--                               20260909360000, both rewriting the description
--                               for the truncation/sweep notes.
--
-- Both caveats exist because Ask SILO produced a wrong answer without them:
-- summing conversion_value across platforms as revenue, and declaring that
-- collections "don't exist" because they were absent from a top-250 slice.
-- Losing them silently reopens exactly those answers.
--
-- Written as APPENDS, guarded, so re-running is a no-op and the text the
-- later migrations added is kept. The rule for future edits to these rows:
-- `description = description || '...'`, never `set description = '...'` --
-- and the daily drift check now catches a repeat the next morning.
-- ---------------------------------------------------------------------------

update public.silo_chat_schema_catalog
set description = coalesce(description, '') ||
  ' CLAIMED, NOT ACTUAL: conversion_value is what each PLATFORM claims it drove, '
  'measured by its own pixel with its own attribution window -- Meta, Google and '
  'TikTok each claim their share of the same order, so summing conversion_value '
  'across platforms double-counts and can exceed real sales. It is not revenue. '
  'Actual online revenue is sales_by_day / wow_sales_daily_type_v; compare the '
  'two through wow_paid_media_reality(), never by adding platform rows.',
    updated_at = now()
where relname = 'marketing_kpis_daily'
  and coalesce(description, '') not like '%CLAIMED, NOT ACTUAL%';

update public.silo_chat_schema_catalog
set description = coalesce(description, '') ||
  ' ABSENCE IS NOT NONEXISTENCE: a path missing from this table for a day was '
  'not in that day''s top-N -- it says nothing about whether the page exists, '
  'is published, or had traffic below the cut. SILO stores no registry of '
  'pages here; for collections use shopify_collections, and never conclude a '
  'page "does not exist" or "had zero sessions" from its absence in this table.',
    updated_at = now()
where relname = 'shopify_landing_pages_daily'
  and coalesce(description, '') not like '%ABSENCE IS NOT NONEXISTENCE%';
