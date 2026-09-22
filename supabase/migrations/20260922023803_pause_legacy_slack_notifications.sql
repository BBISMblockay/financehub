-- Pause the Baseballism-only Slack integration before external pilots.
--
-- These seven triggers and the daily cron all called the public, unauthenticated
-- notify-slack Edge Function. That function embedded one Baseballism webhook,
-- so every tenant's operational events could be posted into Baseballism's
-- workspace. Removing SLACK_* secrets did not affect this legacy path.
--
-- Keep the newer sample-notify trigger: its email path is tenant-aware and its
-- optional Slack path already becomes a no-op when its secret is absent.

drop trigger if exists trg_slack_payment_request on public.payment_requests;
drop trigger if exists trg_slack_po_created on public.po_headers;
drop trigger if exists trg_slack_po_sent on public.po_headers;
drop trigger if exists trg_slack_sample_created on public.product_samples;
drop trigger if exists trg_slack_task_created on public.launch_tasks;
drop trigger if exists trg_slack_launch_created on public.launch_calendar;
drop trigger if exists trg_slack_launch_comment on public.launch_comments;

drop function if exists public.notify_slack_payment_request();
drop function if exists public.notify_slack_po_created();
drop function if exists public.notify_slack_po_sent();
drop function if exists public.notify_slack_sample_created();
drop function if exists public.notify_slack_task_created();
drop function if exists public.notify_slack_launch_created();
drop function if exists public.notify_slack_launch_comment();

-- pg_cron must be changed through its API, not by writing cron.job directly.
do $pause_slack_cron$
declare
  _job_id bigint;
begin
  for _job_id in
    select jobid
    from cron.job
    where jobname = 'silo-daily-slack-summary'
       or command ilike '%send_daily_slack_summary%'
  loop
    perform cron.unschedule(_job_id);
  end loop;
end;
$pause_slack_cron$;

drop function if exists public.send_daily_slack_summary();
