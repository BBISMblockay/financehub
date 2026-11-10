-- Affiliate Studio: "Find creators with AI" and "Import a list".
--
-- Two CHECK constraints learn one value each, nothing else changes:
--   * ai_credit_reservations.feature gains 'affiliate_research', so the
--     affiliate-research edge function can hold and settle AI credit exactly as
--     Ask SILO does (docs/ops/ai-credits.md);
--   * affiliate_prospects.source gains 'ai_research', so a creator the AI found
--     (and SILO confirmed on a page the AI actually read) is told apart from a
--     search result ('serp') and an imported row ('csv_import', already allowed).
--
-- Idempotent: each constraint is dropped if present and re-added with the full
-- list. The lists are the live production lists of 2026-11-10 plus the one new
-- value. Apply BEFORE deploying affiliate-research: without it the credit hold
-- (enforce mode) and every prospect write from that function are refused.
begin;

alter table public.ai_credit_reservations drop constraint if exists ai_credit_reservations_feature_check;
alter table public.ai_credit_reservations add constraint ai_credit_reservations_feature_check
  check (feature = any (array['ask_silo', 'on_deck', 'card_coding', 'payment_request_extract', 'affiliate_research']::text[]));

alter table public.affiliate_prospects drop constraint if exists affiliate_prospects_source_check;
alter table public.affiliate_prospects add constraint affiliate_prospects_source_check
  check (source = any (array['serp', 'manual', 'csv_import', 'applied', 'ai_research']::text[]));

commit;
