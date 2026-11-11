-- 20261111180000 -- the feed-health catalog entry learns 'not_configured'.
--
-- The reconcile pass (scripts/reconcile-integrations.mjs) gained two verdicts
-- for feeds where nothing has arrived and nothing is failing:
--
--   not_configured     a person never finished setting the connection up
--                      (no credential, no account id), so no sync has ever
--                      had anything to run
--   synced_but_empty   the sync RAN and had nothing to write -- a store with
--                      nothing stocked, a keyword set nobody has filled in --
--                      now also reached from the recorded run rather than
--                      only from a stamp on the connection
--
-- Before this, all three of production's cases read 'enabled_but_empty',
-- whose detail line says "the sync is failing, not the enrolment". None of
-- the three had a failing sync. A connected AI reads these state names out of
-- this description to decide whether missing rows mean a decline, so the new
-- name has to be in the list or a bot will read it as an unexplained gap.
--
-- Catalog description only: no view, policy, grant or report query changes,
-- so no report and no tie-out is touched.
--
-- Idempotent: an UPDATE to a known value, matched on the one relname.

begin;

update public.silo_chat_schema_catalog set
  description = $d$WHETHER EACH FEED IS ACTUALLY ARRIVING -- read this before concluding that data is missing. One row per feed per connection for the company, as the daily reconciler last judged it: state and severity ('ok', 'warn', 'action'), a detail line in words, lag_days against tolerance_days, coverage, and expires_in_days for an authorisation about to lapse. BLANK IS NOT ZERO, and this is how to tell which: a feed reading 'stale', 'never_imported', 'synced_but_empty', 'not_configured' or 'expired' means the rows you are missing were never delivered, so say the sync is behind rather than reporting a decline. Two of those are nobody's fault and carry severity 'warn': 'not_configured' is a connection whose setup was never finished, and 'synced_but_empty' can be a sync that ran and had nothing to write (a store with nothing stocked, a keyword set nobody has filled in) -- the detail line says which. CHECK observation_stale AND observed_hours_ago FIRST: the verdicts are formed once a day, and if the reconciler itself has stopped, observation_stale is true and nothing here is confirmed. event_driven feeds (returns, for one) are never judged on lag, because no rows is a normal business state for them. The connection tables behind this are hidden from you, so this view is the only way to see it.$d$,
  updated_at = now()
where relname = 'silo_feed_health_v';

commit;
