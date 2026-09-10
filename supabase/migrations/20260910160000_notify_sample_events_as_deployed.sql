-- 20260910160000_notify_sample_events_as_deployed.sql
-- ---------------------------------------------------------------------------
-- Records what production ACTUALLY runs for notify_sample_events(), which is
-- not what 20260818130000 -> 20260818200000 define. The first scheduled run of
-- deployment-drift-check.yml (2026-09-10) found the deployed trigger function
-- is a hand-edited version that no migration contained: it fires
--
--   SAMPLE_REQUESTED / SAMPLE_RECEIVED   on INSERT only
--   SAMPLE_SIZE_REQUEST                  only for request_source =
--                                        'catalog_photo_request'
--
-- and nothing else. The SAMPLE_ASSIGNED, SAMPLE_WAREHOUSE_READY and
-- received-on-UPDATE paths in the migrations never fire from the database,
-- although the deployed sample-notify edge function still handles all five.
--
-- DECISION (Blake, 2026-09-10): do not re-apply the wider version. Sample
-- notifications are being redesigned as part of a Slack rebuild, and that
-- work will define the trigger deliberately. Until then the repo should
-- describe production rather than a version that never ran, so this
-- migration is the deployed body verbatim (pg_get_functiondef, 2026-09-10)
-- and verify checks 28 and 33 now assert THIS shape. Applying it to
-- production is a no-op by construction.
--
-- When the Slack rebuild replaces this, replace the two verify checks with
-- it -- do not "fix" this file back to 20260818200000.
-- ---------------------------------------------------------------------------

create or replace function public.notify_sample_events()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if tg_op = 'INSERT'
     and (new.assigned_to is not null or new.request_source is not null)
     and (new.size_requests is null or btrim(new.size_requests) = '') then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object(
        'type', case when coalesce(new.sample_status,'') in ('received','pps_received','full_run_received')
                     then 'SAMPLE_RECEIVED' else 'SAMPLE_REQUESTED' end,
        'record', row_to_json(new)
      )
    );
  end if;

  if new.request_source = 'catalog_photo_request'
     and new.size_requests is not null and btrim(new.size_requests) <> ''
     and (tg_op = 'INSERT' or old.size_requests is distinct from new.size_requests) then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object('type', 'SAMPLE_SIZE_REQUEST', 'record', row_to_json(new))
    );
  end if;

  return new;
end;
$$;
