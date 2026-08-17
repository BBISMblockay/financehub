-- 20260817190000_sample_notifications.sql
--
-- Samples had zero notification infrastructure — nothing emailed or posted
-- to Slack when a sample arrived or when someone flagged which sizes were
-- needed. Per Blake, directly: "it won't work how we want it to without
-- this step." Two trigger events, matching what was actually asked for
-- (not every one of the 10 sample_status values — that would be noise):
--
--   1. SAMPLE_RECEIVED       — an existing sample transitions into 'received'
--   2. SAMPLE_SIZE_REQUEST   — size_requests is set/changed to a non-empty value
--
-- Both post to the new sample-notify edge function (supabase/functions/
-- sample-notify/index.ts), which sends email (Resend) to the sample's
-- company's active `logistics`-department members and, if
-- SLACK_SAMPLES_WEBHOOK_URL is configured, a Slack message. Neither channel
-- is required for the other to work — same optional-secret pattern as every
-- other notify function in this repo (RESEND_API_KEY missing => email
-- silently skipped, not an error).
--
-- Same net.http_post-from-a-trigger pattern as notify_slack_po_sent()
-- (20260709030000_slack_po_status_accuracy.sql) — no Authorization header,
-- because there is no mechanism for a Postgres trigger to attach a
-- Supabase-signed JWT to an outbound call. sample-notify is deployed with
-- verify_jwt: false to match, and validates its payload shape strictly
-- instead of trusting a bearer token that can't exist here.
--
-- IMPORTANT — discovered while building this, not before: an existing
-- trigger (trg_slack_sample_created / notify_slack_sample_created(), not in
-- this repo's migrations, presumably applied directly like notify-slack
-- itself) already fires on EVERY INSERT into product_samples and posts
-- type SAMPLE_CREATED to the existing notify-slack function. sample_status
-- very likely defaults to 'received' for a newly logged sample, so an
-- INSERT-time branch here would have fired a SECOND Slack message for the
-- same event on nearly every new sample — the exact duplicate-notification
-- problem this feature exists to avoid causing elsewhere. SAMPLE_RECEIVED
-- below is deliberately UPDATE-only: a sample that was NOT already
-- 'received' transitioning into that status. That is a genuinely distinct
-- event the pre-existing trigger cannot see (it only fires on INSERT), so
-- there is no overlap. Whether the pre-existing SAMPLE_CREATED integration
-- is actually reaching a real Slack channel today was not verified here —
-- its source isn't in this repo — worth confirming separately.

create or replace function public.notify_sample_events()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
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

  return new;
end;
$$;

revoke execute on function public.notify_sample_events() from public, anon;

drop trigger if exists trg_sample_notify on public.product_samples;
create trigger trg_sample_notify
  after insert or update on public.product_samples
  for each row execute function public.notify_sample_events();
