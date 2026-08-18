-- 20260818180000_sample_insert_no_double_fire.sql
--
-- Confirmed live in #silo-samples: the Catalog "+ Request Sample" flow
-- creates a row with request_source AND size_requests both set in the same
-- INSERT, which fired two separate Slack messages for one action --
-- SAMPLE_REQUESTED ("requested a photo sample") immediately followed by
-- SAMPLE_SIZE_REQUEST ("requested photo samples ... S, M, L, XL, XXL") for
-- the exact same sample. The size-request message already contains
-- everything the plain one does, plus the actual sizes -- the second
-- message added no information, just noise.
--
-- Fix: the INSERT-time SAMPLE_REQUESTED/SAMPLE_RECEIVED branch now only
-- fires when size_requests is NOT already set at creation. If it is, the
-- size-request branch (unchanged) is the single notification for that
-- INSERT. Sizes added later via an UPDATE still fire SAMPLE_SIZE_REQUEST
-- on their own, same as before -- this only changes the INSERT-time case
-- where both would otherwise fire together.

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
        'type', case when coalesce(new.sample_status,'') = 'received' then 'SAMPLE_RECEIVED' else 'SAMPLE_REQUESTED' end,
        'record', row_to_json(new)
      )
    );
  end if;

  if tg_op = 'UPDATE'
     and coalesce(old.sample_status,'') is distinct from 'received'
     and new.sample_status = 'received' then
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
