-- Draft POs are work-in-progress — don't post them to Slack at all.
-- The INSERT notification now fires only for POs created in a non-Draft
-- status (e.g. created directly as 'Sent to Factory'); a draft that later
-- gets sent is announced by trg_slack_po_sent (20260709030000) at the
-- moment its status transitions.

create or replace function public.notify_slack_po_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(new.status, '') <> 'Draft' then
    perform net.http_post(
      url  := 'https://mkquclffrvlzyecnabyf.supabase.co/functions/v1/notify-slack',
      body := jsonb_build_object('type', 'PO_CREATED', 'record', row_to_json(new))
    );
  end if;
  return new;
end;
$$;

revoke execute on function public.notify_slack_po_created() from public, anon;
