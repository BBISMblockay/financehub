-- Klaviyo system reports: drop a tie-out that was RENAMED, not edited.
--
-- 20261109210000 was applied to production from an earlier revision of itself,
-- before review fixes landed: the Performance report's sanity check was called
-- "One row per message and channel, never one per window" and became
-- "One row per message, channel and metric, never one per window" when the
-- conversion metric joined the grain.
--
-- silo_report_tieouts is unique on (report_id, name), so re-running that
-- migration INSERTS the new name and leaves the old row behind: enabled,
-- carrying an md5 of a definition that no longer exists, so it reads NO DATA
-- for ever and the nightly tie-out run reports a stale check against a report
-- that is in fact fine. Deleting it is the whole fix.
--
-- Written as "delete what is not in the current set" rather than "delete that
-- one name", so the same thing happening on a later rename is cleaned by
-- re-running this file instead of needing another migration. It can run
-- before or after 20261109210000; neither order leaves a stale row.
delete from public.silo_report_tieouts
 where report_id in ('c9000000-0000-4000-a000-000000000001',
                     'c9000000-0000-4000-a000-000000000002',
                     'c9000000-0000-4000-a000-000000000003')
   and name not in ('One row per message, channel and metric, never one per window',
                    'Attributed revenue agrees with the base tables, ranked a different way',
                    'Attributed flow revenue agrees with the Klaviyo base table',
                    'Channel totals add up to Email & SMS Performance');
