-- Scheduled report email: separate "how often" from "what time".
--
-- `cadence_preset` has carried its hour inside its name since 20261013180000,
-- and the four values shipped were one hour per frequency: weekdays at 7:00,
-- every day at 6:00, Mondays at 7:00, the 1st at 7:00. A merchant setting up a
-- schedule reads that as two decisions, not one, and could only make the second
-- by changing the first. This completes the matrix so the UI can offer two
-- controls that mean what they say.
--
-- WHY ONLY 6:00 AND 7:00. The delivery runner is a GitHub Actions cron
-- (`report-email-sync.yml`, `5 13,14,15,18,23 * * *`), and it selects rows whose
-- `next_run_at` has PASSED. 13:00/14:00 UTC is 6:00/7:00 Pacific under PDT and
-- 14:00/15:00 is the same under PST, so both times are covered all year. The
-- later slots are catch-ups: 18:00 UTC is 11:00 PDT but 10:00 PST, so an hour
-- offered there would be an hour wrong for half the year. Adding a time to this
-- list means adding a cron slot that covers it in BOTH offsets first -- the
-- schema is not the constraint, the runner is.
--
-- `computeNextRunAt` used to match these names literally, so a value this
-- migration adds would have fallen through to "tomorrow" and ignored the
-- weekday. It now parses `<frequency>_<HHMM>`; the three copies of it
-- (v3/js/report-email-schedule.js, scripts/lib/report-email-deliver-core.mjs,
-- supabase/functions/report-email-deliver/lib/report-email-deliver-core.mjs)
-- were changed in the same PR as this file, and
-- scripts/tests/report-email-deliver.test.mjs runs two of them over the same
-- fixtures. Apply this migration only with that code deployed, or a saved
-- 6:00 weekday schedule would compute a Saturday.
--
-- Additive and idempotent: every existing row keeps its value, and no row's
-- next_run_at is touched.

alter table public.report_email_schedules
  drop constraint if exists report_email_schedules_cadence_preset_check;

alter table public.report_email_schedules
  add constraint report_email_schedules_cadence_preset_check
  check (cadence_preset in (
    'weekdays_0600', 'weekdays_0700',
    'daily_0600', 'daily_0700',
    'monday_0600', 'monday_0700',
    'month_first_0600', 'month_first_0700'
  ));

comment on column public.report_email_schedules.cadence_preset is
  '<frequency>_<HHMM> in the company''s business timezone: frequency is one of weekdays, daily, monday, month_first, and HHMM is 0600 or 0700. Only those two times are offered because the delivery runner is a GitHub Actions cron whose slots cover 6:00 and 7:00 Pacific under both PDT and PST and nothing else in both (see 20261120040000). Parsed, not matched literally -- adding a frequency means teaching computeNextRunAt in all three of its copies.';
