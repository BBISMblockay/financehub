-- 20260818130000_product_samples_assignee_notifications.sql
--
-- Sample requests routinely need to go to a specific warehouse/logistics
-- person, not just "everyone in the logistics department" (the only option
-- sample-notify has had since 20260817190000). This adds a stored assignee
-- to product_samples (same shape as mail_items.assigned_to /
-- mail_items_v — see 20260721000000_mailroom_rebuild.sql) plus two new
-- trigger events so a specific person can be told "this sample was
-- requested" and "this sample is ready", not only "sizes were requested" /
-- "received":
--
--   1. SAMPLE_REQUESTED         — a new sample row is created (INSERT) AND
--        it is an actual request, not an internal draft: assigned_to is
--        set (someone specific was asked) or request_source is set (e.g.
--        the Catalog tab's "+ Request Sample" flow). A blank pipeline
--        pre-production placeholder with neither stays silent — same
--        "not every event, that would be noise" restraint the original
--        migration applied to sample_status. Deliberately does NOT overlap
--        with the pre-existing, undocumented trg_slack_sample_created
--        trigger (fires SAMPLE_CREATED to the separate notify-slack
--        function on every insert) — that one posts to Slack only, this
--        one emails/Slack-pings via sample-notify and is the first time an
--        actual "requested" email goes out.
--   2. SAMPLE_WAREHOUSE_READY   — a transition into sample_status =
--        'warehouse_ready', mirroring the existing UPDATE-only
--        SAMPLE_RECEIVED pattern.
--   3. SAMPLE_ASSIGNED          — assigned_to is set or changed to a new,
--        non-null value on an UPDATE (an insert with assigned_to already
--        set only fires SAMPLE_REQUESTED — the requested email already
--        names the assignee, a second "assigned to you" email for the
--        same moment would be noise).
--
-- sample-notify (supabase/functions/sample-notify/index.ts) now resolves
-- recipients per-event: when record.assigned_to is set, it emails that one
-- person directly instead of broadcasting to the whole logistics
-- department. Unassigned samples keep the existing department-broadcast
-- behavior — assigning someone narrows the notification, it doesn't add a
-- new gate.

alter table public.product_samples
  add column if not exists assigned_to uuid references public.profiles(id);

create index if not exists product_samples_assigned_to_idx
  on public.product_samples (assigned_to);

comment on column public.product_samples.assigned_to is
  'Optional single person (usually warehouse/logistics) this sample request is routed to. When set, sample-notify emails this person directly instead of broadcasting to the whole logistics department. Mirrors mail_items.assigned_to.';

-- Same enriched-view pattern as mail_items_v: base table stays the write
-- target, the view adds the assignee's display name/email so the UI and
-- edge function don't each re-implement the join.
create or replace view public.product_samples_v
with (security_invoker = true) as
select
  s.*,
  assigned.name  as assigned_to_name,
  assigned.email as assigned_to_email,
  creator.name   as created_by_name,
  creator.email  as created_by_email
from public.product_samples s
left join public.profiles assigned on assigned.id = s.assigned_to
left join public.profiles creator  on creator.id  = s.created_by;

revoke all on public.product_samples_v from anon;
grant select on public.product_samples_v to authenticated;

create or replace function public.notify_sample_events()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- SAMPLE_REQUESTED: a brand-new sample row that is an actual request
  -- (routed to someone, or created via a named request flow) rather than a
  -- blank internal draft. Distinct from the pre-existing
  -- trg_slack_sample_created trigger (Slack-only, no email, not in this
  -- repo's migrations) — this is the first actual "requested" notification.
  if tg_op = 'INSERT' and (new.assigned_to is not null or new.request_source is not null) then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object('type', 'SAMPLE_REQUESTED', 'record', row_to_json(new))
    );
  end if;

  -- SAMPLE_RECEIVED: a transition into 'received' from some other status.
  -- Deliberately UPDATE-only — see note above on trg_slack_sample_created.
  if tg_op = 'UPDATE'
     and coalesce(old.sample_status,'') is distinct from 'received'
     and new.sample_status = 'received' then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/sample-notify',
      body := jsonb_build_object('type', 'SAMPLE_RECEIVED', 'record', row_to_json(new))
    );
  end if;

  -- SAMPLE_WAREHOUSE_READY: a transition into 'warehouse_ready' — the
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
  -- UPDATE. INSERT-time assignment is covered by SAMPLE_REQUESTED above
  -- (which already names the assignee) — no separate ping for the same
  -- moment.
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
