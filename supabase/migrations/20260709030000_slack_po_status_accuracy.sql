-- Slack PO notifications: stop claiming every new PO was "Sent to Factory".
--
-- The INSERT trigger fires for every po_headers row — 20 of 73 POs are
-- Drafts — but the notify-slack edge function's header was hardcoded
-- "New PO Sent to Factory" and the daily summary counted all new POs as
-- "sent to factory". Paired with a notify-slack edge function update
-- (status-aware headers + new PO_SENT type + split summary counts):
--
-- 1. notify_slack_po_sent(): AFTER UPDATE trigger that fires when a PO's
--    status transitions TO 'Sent to Factory' — the moment that actually
--    matters. The INSERT notification remains (now honestly labeled).
-- 2. send_daily_slack_summary(): splits new POs into sent-to-factory vs
--    drafts/other, and "arriving in 7 days" no longer counts Cancelled or
--    already-Received POs.

create or replace function public.notify_slack_po_sent()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'Sent to Factory'
     and old.status is distinct from new.status then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/notify-slack',
      body := jsonb_build_object('type', 'PO_SENT', 'record', row_to_json(new))
    );
  end if;
  return new;
end;
$$;

revoke execute on function public.notify_slack_po_sent() from public, anon;

drop trigger if exists trg_slack_po_sent on public.po_headers;
create trigger trg_slack_po_sent
  after update of status on public.po_headers
  for each row execute function public.notify_slack_po_sent();

create or replace function public.send_daily_slack_summary()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  _since         timestamptz := now() - interval '24 hours';
  _new_req       int;
  _new_pos       int;
  _new_pos_sent  int;
  _new_pos_draft int;
  _new_samples   int;
  _new_tasks     int;
  _new_launches  int;
  _arriving_7d   int;
  _not_ready     int;
begin
  select count(*) into _new_req     from public.payment_requests where created_at >= _since;
  select count(*) into _new_pos     from public.po_headers       where created_at >= _since;
  select count(*) into _new_pos_sent
    from public.po_headers
    where created_at >= _since and status = 'Sent to Factory';
  _new_pos_draft := _new_pos - _new_pos_sent;
  select count(*) into _new_samples from public.product_samples  where created_at >= _since;
  select count(*) into _new_tasks   from public.launch_tasks     where created_at >= _since;
  select count(*) into _new_launches from public.launch_calendar where created_at >= _since;

  select count(*) into _arriving_7d
    from public.po_headers
    where expected_arrival_date between current_date and current_date + 7
      and coalesce(status, '') not in ('Cancelled', 'Received', 'Draft');

  select count(*) into _not_ready
    from public.launch_calendar
    where launch_date between current_date and current_date + 7
      and (launch_readiness is null or launch_readiness <> 'ready');

  perform net.http_post(
    url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/notify-slack',
    body := jsonb_build_object(
      'type',               'DAILY_SUMMARY',
      'new_requests',       _new_req,
      'new_pos',            _new_pos,
      'new_pos_sent',       _new_pos_sent,
      'new_pos_draft',      _new_pos_draft,
      'new_samples',        _new_samples,
      'new_tasks',          _new_tasks,
      'new_launches',       _new_launches,
      'arriving_7d',        _arriving_7d,
      'launches_not_ready', _not_ready
    )
  );
end;
$$;

revoke execute on function public.send_daily_slack_summary() from public, anon;
