-- Work-queue SILO reports: what needs doing, not how the business did.
--
-- WHY
--
-- SILO's MCP server, the developer API, Ask SILO and dashboards all read the
-- same catalog of `source = 'system'` reports, and until now every one of
-- them was a business metric (sales, stock, POs, marketing). A person's own
-- bot could say what sold yesterday but not what is waiting on them. These
-- three reports add that, with no new code path: the MCP's run_report, the
-- API's silo_api_run_report and chat_run_readonly_query already run any
-- system report, so the whole change is three catalog rows and their
-- tie-outs. No table, view, function, grant, scope or path-allowlist entry.
--
-- WHO SEES WHAT
--
-- Each report reads RLS-protected tables and security_invoker views only, so
-- the rows are exactly what that person already sees in SILO, in their
-- company. Measured on production 2026-10-30 (rolled back):
--   - Through the API, silo_api_run_report is SECURITY DEFINER owned by
--     silo_api_exec, which inherits `authenticated` and has no BYPASSRLS.
--     With an integration token's claims, auth.uid() is the person who
--     granted the connection and active_company_id() is the GRANT's company
--     (20261020030000), so RLS scopes by both. Baseballism read 168 uncoded
--     bank rows of the 192 across tenants, and 132 of 133 open requests.
--   - As a membership `member`, payment_requests showed only that person's
--     own 2, and nobody else's private tasks came through.
-- The report SQL adds no filter of its own that could widen this. "Mine"
-- is a column (is_mine), computed from auth.uid(), not a filter.
--
-- WHAT IS LEFT OUT, ON PURPOSE
--
--   - Compensation requests: salary data, and not asked for. Sending it to a
--     third-party model is its own decision.
--   - Bank feed exceptions: readable only by finance, so for everyone else a
--     row would read 0 when the truth is "not visible to you".
--   - Writes of any kind. Every row carries open_in_silo, a link to the exact
--     place in SILO where a person does the work. SILO stays the context
--     layer; the person acts.
--
-- An initiative need not belong to a launch: Schedule saves one with no
-- launch as launch_id NULL. Those are kept (left join) and link to Schedule.
--
-- Initiatives (launch_channel_items) carry their owner as free text
-- ("Grant", "benny", an email), so is_mine matches it only against the
-- person's full name or email, case-insensitive. A first name alone is not
-- matched: two people can share one.
--
-- Links use https://get-silo.com, the product domain every tenant can sign
-- in on. silo-baseballism.com serves the same pages.
--
-- Idempotent: fixed ids, `on conflict (id) do update`, and the tie-outs are
-- deleted and rewritten for these three reports only.

insert into public.silo_chat_saved_reports
  (id, company_entity_id, created_by, source, visibility, title, description, question, answer,
   queries_run, parameters, columns_metadata)
values
  ('c7000000-0000-4000-a000-000000000001', null, null, 'system', 'company',
   'Open work',
   'Every open task, launch initiative and payment request in the company that you can see, with its status, due date, days overdue and who it is waiting on. is_mine is true for work assigned to you, and for your own payment requests that need more information from you. Initiatives match you only when their owner is your full name or email. Each row links to where the work is done in SILO.',
   null, null,
   array[$q$with today as (
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
   '[]'::jsonb,
   '{"work_type":{"label":"Type","semantic":"category","source":"authored"},
     "item":{"label":"Item","source":"authored"},
     "status":{"label":"Status","semantic":"category","source":"authored"},
     "priority":{"label":"Priority","semantic":"category","source":"authored"},
     "due_date":{"label":"Due","semantic":"date","source":"authored"},
     "days_overdue":{"label":"Days overdue","semantic":"count","source":"authored"},
     "assigned_to":{"label":"Waiting on","semantic":"category","source":"authored"},
     "is_mine":{"label":"Mine","semantic":"boolean","source":"authored"},
     "launch":{"label":"Launch","source":"authored"},
     "open_in_silo":{"label":"Open in SILO","semantic":"link","source":"authored"}}'::jsonb),

  ('c7000000-0000-4000-a000-000000000002', null, null, 'system', 'company',
   'Launches next 30 days',
   'Launches on the calendar from today through the next 30 days, plus any still running, with their readiness and how many of their tasks and marketing initiatives are still open, overdue or blocked. Each row links to the launch in the Launch Calendar.',
   null, null,
   array[$q$with today as (
  select public.silo_business_today() as d
), tasks as (
  select t.launch_id,
         count(*) filter (where t.status <> 'done') as open_tasks,
         count(*) filter (where t.status <> 'done' and t.due_date < (select d from today)) as overdue_tasks
    from public.launch_tasks t
   where t.launch_id is not null
   group by t.launch_id
), initiatives as (
  select i.launch_id,
         count(*) filter (where i.status <> 'live') as open_initiatives,
         count(*) filter (where i.status = 'blocked') as blocked_initiatives
    from public.launch_channel_items i
   group by i.launch_id
)
select l.launch_date,
       l.launch_end_date,
       l.title as launch,
       l.launch_type,
       l.status,
       l.launch_readiness,
       l.launch_date - (select d from today) as days_until_launch,
       coalesce(t.open_tasks, 0) as open_tasks,
       coalesce(t.overdue_tasks, 0) as overdue_tasks,
       coalesce(i.open_initiatives, 0) as open_initiatives,
       coalesce(i.blocked_initiatives, 0) as blocked_initiatives,
       l.designer,
       l.po_number,
       l.expected_units,
       'https://get-silo.com/v2/launch-calendar.html?launch=' || l.id as open_in_silo
  from public.launch_calendar l
  left join tasks t on t.launch_id = l.id
  left join initiatives i on i.launch_id = l.id
 where l.launch_date <= (select d from today) + 30
   and coalesce(l.launch_end_date, l.launch_date) >= (select d from today)
 order by l.launch_date, l.title$q$],
   '[]'::jsonb,
   '{"launch_date":{"label":"Launch date","semantic":"date","source":"authored"},
     "launch_end_date":{"label":"Ends","semantic":"date","source":"authored"},
     "launch":{"label":"Launch","source":"authored"},
     "launch_type":{"label":"Type","semantic":"category","source":"authored"},
     "status":{"label":"Status","semantic":"category","source":"authored"},
     "launch_readiness":{"label":"Readiness","semantic":"category","source":"authored"},
     "days_until_launch":{"label":"Days until launch","semantic":"number","source":"authored"},
     "open_tasks":{"label":"Open tasks","semantic":"count","source":"authored"},
     "overdue_tasks":{"label":"Overdue tasks","semantic":"count","source":"authored"},
     "open_initiatives":{"label":"Open initiatives","semantic":"count","source":"authored"},
     "blocked_initiatives":{"label":"Blocked initiatives","semantic":"count","source":"authored"},
     "designer":{"label":"Designer","source":"authored"},
     "po_number":{"label":"PO","source":"authored"},
     "expected_units":{"label":"Expected units","semantic":"count","source":"authored"},
     "open_in_silo":{"label":"Open in SILO","semantic":"link","source":"authored"}}'::jsonb),

  ('c7000000-0000-4000-a000-000000000003', null, null, 'system', 'company',
   'Accounting close status',
   'What is still waiting before the books are current: bank and card transactions not yet categorized in SILO, and journal entries waiting for approval or approved but not yet posted to QuickBooks. Counts, the oldest date and its age in days, and a link to where each is done.',
   null, null,
   array[$q$with today as (
  select public.silo_business_today() as d
), items as (
  select 'Bank transactions to categorize'::text as item,
         count(*) as open_count,
         min(t.txn_date) as oldest_date,
         'https://get-silo.com/v2/transactions.html' as open_in_silo,
         1 as sort_key
    from public.card_transactions t
   where t.status = 'uncoded'
  union all
  select 'Journal entries waiting for approval',
         count(*), min(j.entry_date),
         'https://get-silo.com/v2/accounting-books.html#register', 2
    from public.journal_adjustments_v j
   where j.status = 'draft'
  union all
  select 'Journal entries approved, not yet posted',
         count(*), min(j.entry_date),
         'https://get-silo.com/v2/accounting-books.html#register', 3
    from public.journal_adjustments_v j
   where j.status = 'approved'
)
select i.item,
       i.open_count,
       i.oldest_date,
       case when i.oldest_date is null then null else (select d from today) - i.oldest_date end as oldest_age_days,
       i.open_in_silo
  from items i
 order by i.sort_key$q$],
   '[]'::jsonb,
   '{"item":{"label":"Waiting","source":"authored"},
     "open_count":{"label":"Count","semantic":"count","source":"authored"},
     "oldest_date":{"label":"Oldest","semantic":"date","source":"authored"},
     "oldest_age_days":{"label":"Oldest age (days)","semantic":"count","source":"authored"},
     "open_in_silo":{"label":"Open in SILO","semantic":"link","source":"authored"}}'::jsonb)
on conflict (id) do update set
  title = excluded.title, description = excluded.description,
  queries_run = excluded.queries_run, parameters = excluded.parameters,
  columns_metadata = excluded.columns_metadata,
  archived_at = null, updated_at = now();

-- ---------------------------------------------------------------------------
-- Tie-outs. Every system report needs one reconciliation (verify_v2_schema).
-- ---------------------------------------------------------------------------
-- Each check embeds the report's own SQL, guarded by an md5 of
-- (queries_run || parameters) so a check whose report has since changed
-- reads NO DATA instead of a stale pass -- report-tieouts-nightly then calls
-- it STALE. The right-hand side counts the base TABLE directly, not the view
-- or join the report reads, so a join that fans out or drops rows fails.
do $$
declare
  r      record;
  guard  text;
  note   constant text := 'Counts the base table directly. NO DATA means the report changed and this check must be regenerated in the same migration.';
begin
  for r in select * from public.silo_chat_saved_reports
            where id in ('c7000000-0000-4000-a000-000000000001',
                         'c7000000-0000-4000-a000-000000000002',
                         'c7000000-0000-4000-a000-000000000003')
              and source = 'system' and company_entity_id is null
  loop
    guard := format('(select md5(queries_run::text || parameters::text) = %L from public.silo_chat_saved_reports where id = %L)',
                    md5(r.queries_run::text || r.parameters::text), r.id);
    delete from public.silo_report_tieouts where report_id = r.id;

    if r.id = 'c7000000-0000-4000-a000-000000000001' then
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
         r.queries_run[1], guard), 0, note);

    elsif r.id = 'c7000000-0000-4000-a000-000000000002' then
      insert into public.silo_report_tieouts (report_id, name, kind, check_sql, tolerance, note) values
      (r.id, 'Open launch tasks tie to launch_tasks', 'reconciliation',
       format('with report as materialized (%s) select case when %s then coalesce(sum(open_tasks), 0) end as left_value, '
         || '(select count(*) from public.launch_tasks t join public.launch_calendar l on l.id = t.launch_id '
         || 'where t.company_entity_id = (select public.active_company_id()) and t.status <> ''done'' '
         || 'and l.launch_date <= (select public.silo_business_today()) + 30 '
         || 'and coalesce(l.launch_end_date, l.launch_date) >= (select public.silo_business_today())) as right_value from report',
         r.queries_run[1], guard), 0, note),
      (r.id, 'One row per launch in the window', 'sanity',
       format('with report as materialized (%s) select case when %s then count(*) end as left_value, '
         || '(select count(*) from public.launch_calendar l where l.company_entity_id = (select public.active_company_id()) '
         || 'and l.launch_date <= (select public.silo_business_today()) + 30 '
         || 'and coalesce(l.launch_end_date, l.launch_date) >= (select public.silo_business_today())) as right_value from report',
         r.queries_run[1], guard), 0, note);

    else
      insert into public.silo_report_tieouts (report_id, name, kind, check_sql, tolerance, note) values
      (r.id, 'Uncategorized transactions tie to the batch counters', 'reconciliation',
       format('with report as materialized (%s) select case when %s then sum(open_count) filter (where item = ''Bank transactions to categorize'') end as left_value, '
         || '(select coalesce(sum(b.uncoded_count), 0) from public.card_import_batches_v b where b.company_entity_id = (select public.active_company_id())) as right_value from report',
         r.queries_run[1], guard), 0,
       'Line-level count against the per-batch counter the Transactions page shows. A transaction outside any batch, or a stale counter, fails here.'),
      (r.id, 'Open journal entries tie to journal_adjustments', 'reconciliation',
       format('with report as materialized (%s) select case when %s then sum(open_count) filter (where item like ''Journal entries%%'') end as left_value, '
         || '(select count(*) from public.journal_adjustments j where j.company_entity_id = (select public.active_company_id()) and j.status in (''draft'', ''approved'')) as right_value from report',
         r.queries_run[1], guard), 0, note);
    end if;
  end loop;

  if (select count(*) from public.silo_report_tieouts
       where report_id in ('c7000000-0000-4000-a000-000000000001',
                           'c7000000-0000-4000-a000-000000000002',
                           'c7000000-0000-4000-a000-000000000003')) <> 7 then
    raise exception 'work-queue tie-outs: expected 7 checks across the three reports';
  end if;
end $$;
