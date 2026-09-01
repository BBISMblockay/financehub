-- Retiring Action Items & Insights entirely, not extending it.
--
-- compute_silo_insights() shipped 2026-07-09 and was never touched again: it
-- knows nothing about card coding, journal adjustments, comp requests, mail
-- routing, product concepts, or returns -- everything shipped since. The six
-- domains it does cover (sales/inventory/purchasing/planning/ar/ap) still ran
-- correctly against live data, so this isn't a bug fix; it's a call that the
-- module wasn't worth keeping current.
--
-- The half that was ALWAYS broken, discovered while deciding whether to keep
-- it: the nightly AI narrative depends on the GitHub Actions secret
-- ANTHROPIC_API_KEY, which was never set on this repo. Every digest ever
-- generated logged "ANTHROPIC_API_KEY not set — storing findings without a
-- narrative" (confirmed from the last real run's job log, 2026-08-31). The
-- "Briefing" card on /v2/insights.html showed the fallback placeholder on
-- every single load since the feature existed.
--
-- silo_insights_digest holds one row per company (upsert on
-- company_entity_id, no history) -- a rebuildable nightly cache, not a ledger.
-- Nothing else in the schema reads from it or joins against it. Safe to drop
-- outright rather than leave as an orphan table nothing populates anymore.
drop policy if exists silo_insights_digest_active_select on public.silo_insights_digest;
drop table if exists public.silo_insights_digest;
drop function if exists public.compute_silo_insights(uuid);
