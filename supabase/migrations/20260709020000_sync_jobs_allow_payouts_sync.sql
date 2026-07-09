-- The payouts_sync job (20260709010000) never ran: sync_jobs.job_type has a
-- CHECK constraint listing allowed job types, and 'payouts_sync' wasn't in
-- it. startJob()'s insert failed for every connection in the 2026-07-09
-- nightly, which also aborted each connection's inventory snapshot (the
-- payouts step runs first) and failed the workflow. Extend the constraint.

alter table public.sync_jobs drop constraint if exists sync_jobs_job_type_check;
alter table public.sync_jobs add constraint sync_jobs_job_type_check
  check (job_type = any (array[
    'test_connection'::text,
    'history_import'::text,
    'incremental_sales'::text,
    'inventory_snapshot'::text,
    'catalog_sync'::text,
    'payouts_sync'::text
  ]));
