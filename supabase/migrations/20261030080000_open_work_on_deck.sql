-- Open work gains On Deck drafts that need a person.
--
-- On Deck screens and drafts work in the background (on the company's AI
-- credit). A draft that is READY to review, NEEDS INFO from someone, or
-- FAILED is waiting on a person, so it belongs in Open work beside tasks,
-- initiatives and payment requests -- and, through MCP, in a person's own
-- bot. Blake, 2026-10-30.
--
-- Left out on purpose: `screened` (candidates SILO has not drafted, not yet
-- work), `preparing` and `revision` (SILO is still working: "if SILO isn't
-- finished, don't surface it"), and `dismissed` / `completed`.
--
-- Who sees what: on_deck_proposals' only policy is the active company AND
-- on_deck_can_review(), so a person who cannot review On Deck gets no On Deck
-- rows, and the report adds no filter that could widen that. The rows link
-- to /v2/on-deck.html?proposal=<id>, which on-deck.js already opens.
--
-- Idempotent: updates report c7...01 in place and rewrites its tie-outs only.

update public.silo_chat_saved_reports
   set description = $d$Every open task, launch initiative, payment request and On Deck draft in the company that you can see, with its status, due date, days overdue and who it is waiting on. On Deck drafts appear only when ready to review, needing information, or failed, and only to people who can review On Deck. is_mine is true for work assigned to you, and for your own payment requests that need more information from you. Initiatives match you only when their owner is your full name or email. Each row links to where the work is done in SILO.$d$,
       queries_run = array[$q$with today as (
  select public.silo_business_today() as d
), me as (
  select p.id, lower(p.email) as email, lower(p.name) as name
    from public.profiles p
   where p.id = auth.uid()
), items as (
  select 'Task'::text as work_type,
         t.task_title as item,
         t.status,
         t.priority,
         t.due_date,
         coalesce(t.assigned_to_name, 'Unassigned') as assigned_to,
         coalesce(t.assigned_to_user_id = (select id from me), false) as is_mine,
         l.title as launch,
         'https://get-silo.com/v2/tasks.html?task=' || t.id as open_in_silo
    from public.launch_tasks t
    left join public.launch_calendar l on l.id = t.launch_id
   where t.status <> 'done'
  union all
  select 'Initiative',
         coalesce(i.item_title, i.channel) || ' (' || i.channel || ')',
         i.status,
         i.priority,
         i.scheduled_date,
         coalesce(nullif(btrim(i.owner), ''), 'Unassigned'),
         coalesce(lower(btrim(i.owner)) in ((select email from me), (select name from me)), false),
         l.title,
         case when i.launch_id is not null
              then 'https://get-silo.com/v2/launch-calendar.html?launch=' || i.launch_id
              else 'https://get-silo.com/v2/marketing-ops.html' end
    from public.launch_channel_items i
    left join public.launch_calendar l on l.id = i.launch_id
   where i.status <> 'live'
  union all
  select 'Payment request',
         coalesce(r.effective_vendor_name, 'Unknown vendor')
           || coalesce(' · $' || to_char(r.amount_due, 'FM999,999,990.00'), '')
           || coalesce(' · ' || r.request_type, ''),
         r.workflow_status,
         r.priority,
         r.due_date,
         case when r.workflow_status = 'needs_info' then 'Requester: ' || coalesce(r.requester_email, 'unknown')
              else coalesce(r.assigned_to_name, 'Unassigned') end,
         coalesce(case when r.workflow_status = 'needs_info' then r.created_by = (select id from me)
                       else r.assigned_to = (select id from me) end, false),
         null::text,
         'https://get-silo.com/v2/request_manager.html?request=' || r.id
    from public.payment_requests_v r
   where not r.completed
  union all
  select 'On Deck',
         case p.kind when 'seo' then 'SEO' when 'ads' then 'Ads' when 'launch' then 'Launch'
                     when 'restock' then 'Restock' else p.kind end || ': ' || p.title,
         p.status,
         null::text,
         null::date,
         'On Deck reviewers',
         false,
         null::text,
         'https://get-silo.com/v2/on-deck.html?proposal=' || p.id
    from public.on_deck_proposals p
   where p.status in ('ready', 'needs_info', 'failed')
)
select i.work_type,
       i.item,
       i.status,
       i.priority,
       i.due_date,
       case when i.due_date is null then null else greatest((select d from today) - i.due_date, 0) end as days_overdue,
       i.assigned_to,
       i.is_mine,
       i.launch,
       i.open_in_silo
  from items i
 order by i.is_mine desc,
          (i.due_date < (select d from today)) desc nulls last,
          i.due_date nulls last,
          i.work_type,
          i.item$q$],
       archived_at = null,
       updated_at = now()
 where id = 'c7000000-0000-4000-a000-000000000001';

-- Tie-outs for Open work: the three from 20261030060000, regenerated against
-- the new md5, plus one for On Deck. Same shape and note as there.
do $$
declare
  r      record;
  guard  text;
  note   constant text := 'Counts the base table directly. NO DATA means the report changed and this check must be regenerated in the same migration.';
begin
  select * into r from public.silo_chat_saved_reports
   where id = 'c7000000-0000-4000-a000-000000000001' and source = 'system' and company_entity_id is null;
  if not found then
    raise exception 'Open work report missing: run 20261030060000_work_queue_reports.sql first';
  end if;
  guard := format('(select md5(queries_run::text || parameters::text) = %L from public.silo_chat_saved_reports where id = %L)',
                  md5(r.queries_run::text || r.parameters::text), r.id);
  delete from public.silo_report_tieouts where report_id = r.id;

  insert into public.silo_report_tieouts (report_id, name, kind, check_sql, tolerance, note) values
  (r.id, 'Open payment requests tie to payment_requests', 'reconciliation',
   format('with report as materialized (%s) select case when %s then count(*) filter (where work_type = ''Payment request'') end as left_value, '
     || '(select count(*) from public.payment_requests p where p.company_entity_id = (select public.active_company_id()) and not p.completed) as right_value from report',
     r.queries_run[1], guard), 0, note),
  (r.id, 'Open tasks tie to launch_tasks', 'reconciliation',
   format('with report as materialized (%s) select case when %s then count(*) filter (where work_type = ''Task'') end as left_value, '
     || '(select count(*) from public.launch_tasks t where t.company_entity_id = (select public.active_company_id()) and t.status <> ''done'') as right_value from report',
     r.queries_run[1], guard), 0, note),
  (r.id, 'Open initiatives tie to launch_channel_items', 'reconciliation',
   format('with report as materialized (%s) select case when %s then count(*) filter (where work_type = ''Initiative'') end as left_value, '
     || '(select count(*) from public.launch_channel_items i where i.company_entity_id = (select public.active_company_id()) and i.status <> ''live'') as right_value from report',
     r.queries_run[1], guard), 0, note),
  (r.id, 'On Deck drafts tie to on_deck_proposals', 'reconciliation',
   format('with report as materialized (%s) select case when %s then count(*) filter (where work_type = ''On Deck'') end as left_value, '
     || '(select count(*) from public.on_deck_proposals p where p.company_entity_id = (select public.active_company_id()) and p.status in (''ready'', ''needs_info'', ''failed'')) as right_value from report',
     r.queries_run[1], guard), 0, note);

  if (select count(*) from public.silo_report_tieouts
       where report_id in ('c7000000-0000-4000-a000-000000000001',
                           'c7000000-0000-4000-a000-000000000002',
                           'c7000000-0000-4000-a000-000000000003')) <> 8 then
    raise exception 'work-queue tie-outs: expected 8 checks across the three reports';
  end if;
end $$;
