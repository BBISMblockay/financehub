-- 20260818200000_sample_received_transition_within_family.sql
--
-- Gap in 20260818190000: SAMPLE_RECEIVED only fired on a transition from
-- OUTSIDE the received family ('received'/'pps_received'/'full_run_received')
-- into it. That's wrong for the actual PPS -> Full Run workflow: someone
-- logs a sample as PPS Received (fires on INSERT), comes back later when
-- the full run physically arrives, and moves it straight to Full Run
-- Received -- old status was ALREADY in the family (pps_received), so the
-- old condition silently skipped it. No one got told the full run showed
-- up.
--
-- Fixed the same way SAMPLE_SIZE_REQUEST already works: fire on ANY change
-- of sample_status that lands on a received-family value, not just first
-- entry into the family. Still won't fire on a resave with the same value
-- (old is distinct from new), so editing an unrelated field doesn't spam.

create or replace function public.notify_sample_events()
returns trigger
language plpgsql
security definer
set search_path = public
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

  -- SAMPLE_RECEIVED: sample_status changed AND the new value is one of the
  -- three received-family values -- covers both "entering the family from
  -- outside" (e.g. size_request_sent -> full_run_received) and "moving
  -- within it" (e.g. pps_received -> full_run_received directly).
  if tg_op = 'UPDATE'
     and coalesce(new.sample_status,'') in ('received','pps_received','full_run_received')
     and old.sample_status is distinct from new.sample_status then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object('type', 'SAMPLE_RECEIVED', 'record', row_to_json(new))
    );
  end if;

  if tg_op = 'UPDATE'
     and coalesce(old.sample_status,'') is distinct from 'warehouse_ready'
     and new.sample_status = 'warehouse_ready' then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object('type', 'SAMPLE_WAREHOUSE_READY', 'record', row_to_json(new))
    );
  end if;

  if new.size_requests is not null and btrim(new.size_requests) <> ''
     and (tg_op = 'INSERT' or old.size_requests is distinct from new.size_requests) then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object('type', 'SAMPLE_SIZE_REQUEST', 'record', row_to_json(new))
    );
  end if;

  if tg_op = 'UPDATE'
     and new.assigned_to is not null
     and old.assigned_to is distinct from new.assigned_to then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object('type', 'SAMPLE_ASSIGNED', 'record', row_to_json(new))
    );
  end if;

  return new;
end;
$$;

revoke execute on function public.notify_sample_events() from public, anon;

drop trigger if exists trg_sample_notify on public.product_samples;
create trigger trg_sample_notify
  after insert or update on public.product_samples
  for each row execute function public.notify_sample_events();
