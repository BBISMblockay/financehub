-- A skipped step needs a row, and a row needs a status that says so.
--
-- WHAT THIS FIXES. On 2026-09-09 a manual Shopify backfill was dispatched
-- with sessions_days=730 AND skip_sessions=true in the same form. The
-- orchestrator resolved that contradiction in favour of the skip and produced
-- NOTHING: no sync_jobs row, no log line, no warning that a 730-day parameter
-- had been supplied for a stage that would never run. The workflow finished
-- green in two minutes, and the only way to learn that the backfill had not
-- happened was to query shopify_sessions_daily by hand and find it unchanged.
--
-- The orchestrator now records a job row for every stage a run was asked for,
-- including the ones it declined to run, with the reason in `result`. That
-- needs a status this CHECK constraint permits.
--
-- WHY NOT REUSE 'cancelled'. It is already in the constraint and it means
-- something else: a job that started and was stopped. A skipped stage never
-- started. Filing one as cancelled would make "how many syncs were cancelled"
-- unanswerable, and the whole point here is that the record says what
-- actually happened.
--
-- The existing seven values are preserved exactly (read from pg_constraint
-- before writing this, not from a migration file -- the live definition is
-- the one that matters).

alter table public.sync_jobs
  drop constraint if exists sync_jobs_status_check;

alter table public.sync_jobs
  add constraint sync_jobs_status_check check (
    status = any (array[
      'pending'::text,
      'running'::text,
      'success'::text,
      'error'::text,
      'completed'::text,
      'failed'::text,
      'cancelled'::text,
      -- The step was requested (or explicitly turned off) and deliberately
      -- not run. `result` carries the reason. NOT a failure and NOT a
      -- success -- a run where nothing happened must not look like either.
      'skipped'::text
    ])
  );

comment on column public.sync_jobs.status is
  'pending | running | success | error | completed | failed | cancelled | skipped. '
  '"skipped" means the step was NOT RUN and says why in result->>''reason'' -- '
  'it never started, which is what separates it from "cancelled". A partially '
  'completed step is recorded as "error", never "success", with its progress '
  'preserved in result (days_written, earliest/latest_day_written): stopping '
  'short is not the same as failing to start, and neither is a success.';

update public.silo_chat_schema_catalog
set description =
  'Per-connection sync run log. One row per stage per run. status: success, '
  'error, running, pending, cancelled, or SKIPPED (the stage was not run -- '
  'result->>''reason'' says why, e.g. a skip flag contradicting a supplied '
  'days parameter). A stage that ran but did not cover the whole window it '
  'was asked for is recorded as ERROR with its real progress in result '
  '(days_requested, days_fetched, days_written, earliest_day_written, '
  'latest_day_written) -- so never read rows_upserted > 0 as evidence that a '
  'backfill completed, and never read a missing row as evidence a stage '
  'succeeded. Before 2026-09-09 a skipped stage produced no row at all.',
    updated_at = now()
where relname = 'sync_jobs';

select public.refresh_chat_schema_catalog();
