-- notify_slack_task_created() fired for every launch_tasks insert, with no
-- guard — so a private, ad hoc Task Manager assignment between two people
-- (launch_id null, not tied to any marketing launch) posted to the
-- company-wide Slack channel exactly like a real launch project task.
-- Task Manager is for individuals/small teams tracking their own to-dos;
-- it isn't slack-noise-worthy. Only post when the task is actually tied to
-- a launch (launch_id set) and isn't marked private.
--
-- (This function predates any checked-in migration — it was created
-- directly in the SQL editor. Captured here going forward along with the
-- fix, per repo convention that every DB change gets a migration file.)

create or replace function public.notify_slack_task_created()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.launch_id is null or coalesce(new.is_private, false) then
    return new;
  end if;
  perform net.http_post(
    url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/notify-slack',
    body := jsonb_build_object('type', 'TASK_CREATED', 'record', row_to_json(new))
  );
  return new;
end;
$function$;
