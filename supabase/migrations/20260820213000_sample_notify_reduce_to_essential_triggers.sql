-- 20260820213000_sample_notify_reduce_to_essential_triggers.sql
--
-- Blake/Chris in #silo-samples (2026-08-20): the full trigger set (initial
-- request/receive, PPS<->Full Run transitions, warehouse-ready, every
-- assignment change, every size request) reads as a notification for every
-- status change instead of a tool for managing the sample. Direct
-- conclusion from that thread: "Lets keep only notification on initial
-- sample received and size request from catalog and kill the rest."
--
-- Removed entirely:
--   - SAMPLE_RECEIVED on UPDATE (the PPS -> Full Run / into-the-family
--     transition logic added in 20260818190000 and 20260818200000)
--   - SAMPLE_WAREHOUSE_READY
--   - SAMPLE_ASSIGNED as an automatic trigger on assigned_to changing --
--     the manual "Notify now" button in v2/products.html still calls
--     sample-notify directly with this same type, unaffected by this
--     migration since that's a client invoke, not this trigger
--
-- SAMPLE_SIZE_REQUEST is narrowed, not removed: it now only fires for the
-- Catalog "+ Request Sample" flow (request_source = 'catalog_photo_request')
-- -- a plain pipeline sample having its size_requests field edited no
-- longer notifies anyone.
--
-- SAMPLE_REQUESTED / SAMPLE_RECEIVED on INSERT (the "initial sample
-- received" trigger) is unchanged.

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

revoke execute on function public.notify_sample_events() from public, anon;

drop trigger if exists trg_sample_notify on public.product_samples;
create trigger trg_sample_notify
  after insert or update on public.product_samples
  for each row execute function public.notify_sample_events();
