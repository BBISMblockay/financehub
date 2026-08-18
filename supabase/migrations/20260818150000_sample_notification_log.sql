-- 20260818150000_sample_notification_log.sql
--
-- The assignee/Slack-DM work in 20260818130000 made sample-notify's success
-- or failure completely invisible to the browser — the DB trigger's
-- net.http_post fires async, so the person clicking Save or "Notify now"
-- had no way to know whether anyone was actually reached, only that the
-- database write succeeded. That gap is exactly what caused the real
-- debugging session this migration comes out of: a missing Slack OAuth
-- scope silently dropped every DM for over an hour before anyone noticed,
-- and the only way to find out was pulling Supabase edge-function logs by
-- hand.
--
-- sample-notify now writes one row per attempt here (best-effort, wrapped
-- so a logging failure never blocks the actual notification), and the UI
-- reads it two ways: a short poll right after a save that plausibly
-- triggered a notification (so the "Saved." toast gets followed by "Sent
-- to Email – Name" / "Sent to Slack – Name" once the trigger's async call
-- actually completes), and a "Notification Log" panel on the Samples tab
-- for spot-checking recent attempts without needing Supabase dashboard
-- access.

create table if not exists public.sample_notification_log (
  id                uuid primary key default gen_random_uuid(),
  company_entity_id uuid references public.entities(id),
  sample_id         uuid references public.product_samples(id) on delete cascade,
  event_type        text not null,
  recipient_label   text,
  email_sent        boolean not null default false,
  email_reason      text,
  slack_sent        boolean not null default false,
  slack_reason      text,
  slack_dm_sent     boolean not null default false,
  slack_dm_reason   text,
  recipients_count  integer not null default 0,
  created_at        timestamptz not null default now()
);

create index if not exists sample_notification_log_sample_id_idx
  on public.sample_notification_log (sample_id, created_at desc);

create index if not exists sample_notification_log_company_created_idx
  on public.sample_notification_log (company_entity_id, created_at desc);

comment on table public.sample_notification_log is
  'One row per sample-notify send attempt (auto trigger-fired or manual "Notify now"). Written by the service-role client inside sample-notify only -- no client-side insert/update/delete policy exists. Read by the Samples tab Notification Log panel and by the post-save poll that turns the async DB-trigger notification into a visible toast.';

alter table public.sample_notification_log enable row level security;

drop policy if exists sample_notification_log_active_select on public.sample_notification_log;
create policy sample_notification_log_active_select on public.sample_notification_log
  for select using (company_entity_id = active_company_id());

-- No insert/update/delete policy for authenticated/anon -- RLS with zero
-- write policies denies all writes from those roles. Only sample-notify's
-- service-role client (bypasses RLS entirely) writes here.
revoke all on public.sample_notification_log from anon;
grant select on public.sample_notification_log to authenticated;

create or replace view public.sample_notification_log_v
with (security_invoker = true) as
select
  l.*,
  s.product_title,
  s.sample_ref
from public.sample_notification_log l
left join public.product_samples s on s.id = l.sample_id;

revoke all on public.sample_notification_log_v from anon;
grant select on public.sample_notification_log_v to authenticated;
