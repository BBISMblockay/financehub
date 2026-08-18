-- 20260818190000_sample_pps_full_run_received.sql
--
-- The single 'received' pipeline stage is now two more specific ones per
-- Blake/Chris: 'pps_received' (pre-production sample) and
-- 'full_run_received' (the full production run arriving) — v2/products.html
-- offers both as distinct Workflow stages now instead of one generic
-- "Received". sample_status has no DB CHECK constraint (enforced
-- client-side only, same as the other 9 stage values), so no schema change
-- is needed here — only the trigger, which hardcoded the exact string
-- 'received' in two places and would otherwise silently stop firing
-- SAMPLE_RECEIVED notifications for every sample logged under either new
-- value.
--
-- Existing rows already saved as plain 'received' are left as-is — there's
-- no way to know after the fact which of the two a historical row actually
-- was, so this doesn't attempt to backfill them. Both the client
-- (RECEIVED_STATUSES) and this trigger now treat all three values as
-- equivalent for "this counts as received" purposes.

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

  -- SAMPLE_RECEIVED: a transition into any of the three "received" values
  -- from something outside that set. Deliberately excludes INSERT (covered
  -- above) — see the note on trg_slack_sample_created in
  -- 20260817190000_sample_notifications.sql for why.
  if tg_op = 'UPDATE'
     and coalesce(old.sample_status,'') not in ('received','pps_received','full_run_received')
     and coalesce(new.sample_status,'') in ('received','pps_received','full_run_received') then
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
