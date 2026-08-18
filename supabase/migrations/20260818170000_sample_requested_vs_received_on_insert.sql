-- 20260818170000_sample_requested_vs_received_on_insert.sql
--
-- SAMPLE_REQUESTED (20260818130000) fires on every qualifying INSERT
-- regardless of sample_status — but sample_status defaults to 'received',
-- and the Samples-tab drawer's new-sample form starts on that same first
-- pipeline step, so the overwhelming common case is someone logging a
-- sample they already physically have, not requesting one that hasn't
-- arrived yet. Confirmed against both live test rows created today
-- (SMPL-2026-0024/0025): both landed with sample_status='received' at
-- INSERT, and both got a Slack "Sample requested" message that was
-- factually wrong -- they'd already been received.
--
-- Fix: route the INSERT-time notification by the row's actual status at
-- creation. 'received' -> SAMPLE_RECEIVED (this now legitimately fires on
-- INSERT too, not just the pre-existing UPDATE-transition branch below --
-- those are two different real moments that both mean "this sample is
-- received", so reusing the same event type/phrasing for both is correct,
-- not a duplicate). Anything else (someone advanced the pipeline before
-- ever saving -- a genuinely pending pre-production entry) keeps firing
-- SAMPLE_REQUESTED.

create or replace function public.notify_sample_events()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- INSERT-time: an actual request (assignee or request_source set, not a
  -- blank internal draft) -- routed to SAMPLE_RECEIVED or SAMPLE_REQUESTED
  -- by the row's actual status at creation. See header comment.
  if tg_op = 'INSERT' and (new.assigned_to is not null or new.request_source is not null) then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object(
        'type', case when coalesce(new.sample_status,'') = 'received' then 'SAMPLE_RECEIVED' else 'SAMPLE_REQUESTED' end,
        'record', row_to_json(new)
      )
    );
  end if;

  -- SAMPLE_RECEIVED: a transition into 'received' from some other status
  -- on an existing row. Deliberately UPDATE-only -- see note above on
  -- trg_slack_sample_created (fires SAMPLE_CREATED to notify-slack on
  -- every insert already; this avoids a second Slack ping for the same
  -- moment when a fresh insert already lands as 'received').
  if tg_op = 'UPDATE'
     and coalesce(old.sample_status,'') is distinct from 'received'
     and new.sample_status = 'received' then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object('type', 'SAMPLE_RECEIVED', 'record', row_to_json(new))
    );
  end if;

  -- SAMPLE_WAREHOUSE_READY: a transition into 'warehouse_ready' -- the
  -- "ready for pickup" moment, same UPDATE-only shape as SAMPLE_RECEIVED.
  if tg_op = 'UPDATE'
     and coalesce(old.sample_status,'') is distinct from 'warehouse_ready'
     and new.sample_status = 'warehouse_ready' then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object('type', 'SAMPLE_WAREHOUSE_READY', 'record', row_to_json(new))
    );
  end if;

  -- SAMPLE_SIZE_REQUEST: fires when size_requests is set to a non-empty
  -- value AND that value actually changed (or this is an INSERT that
  -- already carries one) — editing an unrelated field on the same row must
  -- not re-fire this.
  if new.size_requests is not null and btrim(new.size_requests) <> ''
     and (tg_op = 'INSERT' or old.size_requests is distinct from new.size_requests) then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object('type', 'SAMPLE_SIZE_REQUEST', 'record', row_to_json(new))
    );
  end if;

  -- SAMPLE_ASSIGNED: assigned_to set/changed to a non-null value on an
  -- UPDATE. INSERT-time assignment is covered by the SAMPLE_REQUESTED/
  -- SAMPLE_RECEIVED branch above (which already names the assignee) — no
  -- separate ping for the same moment.
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
