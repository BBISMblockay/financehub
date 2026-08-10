-- =============================================================================
-- Organization Calendar (V1 foundation)
--
-- Hybrid architecture (see docs/ops/org-calendar.md):
--   1. calendar_events — a real table for MANUAL events only (meetings,
--      holidays, deadlines, milestones). Manual events are the only dates
--      with no other system of record.
--   2. calendar_events_v — a security_invoker UNION ALL view that projects
--      system-generated dates from their source tables into one standard
--      event contract. Sources stay authoritative; nothing is copied.
--
-- Security model: because the view is security_invoker, every branch runs
-- under the caller's own RLS. A member-tier user gets no po_headers or
-- payment_requests rows, a non-finance user gets no payroll rows, private
-- launch_tasks stay private — with zero calendar-specific ACL code. The
-- calendar can never show more than the source tool does.
--
-- Query contract: clients MUST range-bound on start_on
--   (.gte('start_on', from).lte('start_on', to)); the date predicate pushes
-- down into each UNION branch and hits the indexes created below.
-- =============================================================================

-- ── 1. Manual events table ──────────────────────────────────────────────────

create table if not exists public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid references public.entities(id),
  title text not null,
  description text,
  -- Manual taxonomy only; system events get their type from the view.
  event_type text not null default 'company_event'
    check (event_type in ('company_event', 'meeting', 'holiday', 'deadline', 'milestone')),
  start_on date not null,
  end_on date,                -- inclusive; null = single-day event
  start_time time,            -- null = all-day
  location text,
  url text,                   -- optional external link (agenda doc, zoom, …)
  -- company  = every active member of the company
  -- finance  = AP-manager tier (admin membership or finance/admin/exec dept)
  -- private  = creator only
  visibility text not null default 'company'
    check (visibility in ('company', 'finance', 'private')),
  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint calendar_events_range_check check (end_on is null or end_on >= start_on)
);

create index if not exists calendar_events_company_start_idx
  on public.calendar_events (company_entity_id, start_on);
-- Multi-day events are found by their end date too.
create index if not exists calendar_events_company_end_idx
  on public.calendar_events (company_entity_id, end_on)
  where end_on is not null;

alter table public.calendar_events enable row level security;

drop policy if exists calendar_events_active_select on public.calendar_events;
create policy calendar_events_active_select on public.calendar_events
  for select using (
    company_entity_id = active_company_id()
    and (
      visibility = 'company'
      or (visibility = 'finance' and current_user_can_manage_payment_requests())
      or (visibility = 'private' and created_by = auth.uid())
    )
  );

-- Any active company member may create events (stamp triggers fill
-- company_entity_id / created_by before the WITH CHECK runs).
drop policy if exists calendar_events_active_insert on public.calendar_events;
create policy calendar_events_active_insert on public.calendar_events
  for insert with check (company_entity_id = active_company_id());

drop policy if exists calendar_events_active_update on public.calendar_events;
create policy calendar_events_active_update on public.calendar_events
  for update using (
    company_entity_id = active_company_id()
    and (created_by = auth.uid() or is_admin_user())
  )
  with check (company_entity_id = active_company_id());

drop policy if exists calendar_events_active_delete on public.calendar_events;
create policy calendar_events_active_delete on public.calendar_events
  for delete using (
    company_entity_id = active_company_id()
    and (created_by = auth.uid() or is_admin_user())
  );

-- updated_at maintenance (same shape as product_tracker_updated_at).
create or replace function public.calendar_events_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists calendar_events_touch_updated_at on public.calendar_events;
create trigger calendar_events_touch_updated_at
  before update on public.calendar_events
  for each row execute function public.calendar_events_touch_updated_at();

-- Attribution + company-scoping safety nets (standard pattern).
drop trigger if exists stamp_created_by on public.calendar_events;
create trigger stamp_created_by before insert on public.calendar_events
  for each row execute function public.stamp_created_by();

select public.attach_stamp_company_entity_id_triggers();

-- ── 2. Source-date indexes for the projection branches ──────────────────────
-- (po_headers.order_date is already indexed; live_sessions has the unique
--  (company_entity_id, slot_start) index.)

create index if not exists launch_calendar_company_launch_date_idx
  on public.launch_calendar (company_entity_id, launch_date);
create index if not exists launch_channel_items_company_sched_idx
  on public.launch_channel_items (company_entity_id, scheduled_date);
create index if not exists launch_tasks_company_due_idx
  on public.launch_tasks (company_entity_id, due_date)
  where due_date is not null;
create index if not exists po_headers_company_ship_idx
  on public.po_headers (company_entity_id, req_ship_date)
  where req_ship_date is not null;
create index if not exists po_headers_company_arrival_idx
  on public.po_headers (company_entity_id, expected_arrival_date)
  where expected_arrival_date is not null;
create index if not exists payment_requests_company_due_idx
  on public.payment_requests (company_entity_id, due_date)
  where due_date is not null;
create index if not exists payroll_import_batches_company_check_idx
  on public.payroll_import_batches (company_entity_id, check_date)
  where check_date is not null;
create index if not exists mail_items_company_due_idx
  on public.mail_items (company_entity_id, due_date)
  where due_date is not null;

-- ── 3. The organization calendar projection ─────────────────────────────────
--
-- One row per calendar-worthy date. Standard contract (every branch must
-- emit every column, same order, same types):
--   event_id     text   '<source_type>:<uuid>' — stable + unique
--   source_type  text   manual | launch | launch_channel_item | launch_task
--                       | po | payment_request | payroll_batch
--                       | live_session | mail_item
--   source_id    uuid   PK of the source row
--   event_type   text   taxonomy leaf (launch, payment_due, po_arrival, …)
--   category     text   product | supply_chain | finance | people
--                       | operations | company
--   title/detail text
--   start_on     date   the calendar day (range queries bind on this)
--   end_on       date   inclusive; null = single-day
--   start_time   time   null = all-day
--   all_day      bool
--   status       text   source status verbatim
--   amount       numeric only where source RLS already gates it (AP due)
--   owner_id     uuid   assignee / claimer / creator where meaningful
--   url          text   deep link into the source tool
--   source_label text
--   company_entity_id uuid
--
-- Timezone note: all-day sources are plain `date` columns, projected as-is.
-- The one timed source (live_sessions.slot_start, timestamptz UTC) is
-- rendered in Pacific time — the anchor zone the live slot grid is designed
-- around. If a company ever needs a different home zone, swap the constant
-- for an entities.meta lookup here (single point of change).

drop view if exists public.calendar_events_v;
create view public.calendar_events_v
with (security_invoker = true) as

-- Manual events -------------------------------------------------------------
select
  'manual:' || ce.id::text                       as event_id,
  'manual'                                       as source_type,
  ce.id                                          as source_id,
  ce.event_type                                  as event_type,
  case ce.event_type
    when 'deadline'  then 'finance'
    when 'milestone' then 'operations'
    else 'company'
  end                                            as category,
  ce.title                                       as title,
  coalesce(ce.description, ce.location)          as detail,
  ce.start_on                                    as start_on,
  ce.end_on                                      as end_on,
  ce.start_time                                  as start_time,
  (ce.start_time is null)                        as all_day,
  ce.visibility                                  as status,
  null::numeric                                  as amount,
  ce.created_by                                  as owner_id,
  ce.url                                         as url,
  'Org Calendar'                                 as source_label,
  ce.company_entity_id                           as company_entity_id
from public.calendar_events ce

union all

-- Product launches ----------------------------------------------------------
select
  'launch:' || lc.id::text,
  'launch',
  lc.id,
  'launch',
  'product',
  lc.title,
  nullif(concat_ws(' · ', nullif(lc.launch_type, ''), nullif(lc.designer, '')), ''),
  lc.launch_date,
  null::date,
  nullif(lc.launch_time, '00:00:00'::time),
  (lc.launch_time is null or lc.launch_time = '00:00:00'::time),
  lc.status,
  null::numeric,
  lc.created_by,
  '/v2/launch-calendar.html?launch=' || lc.id::text,
  'Launch Workbench',
  lc.company_entity_id
from public.launch_calendar lc
where lc.launch_date is not null

union all

-- Campaign sends (email/SMS initiatives) ------------------------------------
select
  'campaign:' || ci.id::text,
  'launch_channel_item',
  ci.id,
  'campaign_send',
  'product',
  coalesce(nullif(ci.item_title, ''), initcap(coalesce(ci.channel, 'campaign')) || ' send'),
  nullif(concat_ws(' · ', upper(nullif(ci.channel, '')), lc.title), ''),
  ci.scheduled_date,
  null::date,
  nullif(ci.scheduled_time, '00:00:00'::time),
  (ci.scheduled_time is null or ci.scheduled_time = '00:00:00'::time),
  ci.status,
  null::numeric,
  null::uuid,
  case when ci.launch_id is null then '/v2/launch-calendar.html'
       else '/v2/launch-calendar.html?launch=' || ci.launch_id::text end,
  'Launch Workbench',
  ci.company_entity_id
from public.launch_channel_items ci
left join public.launch_calendar lc on lc.id = ci.launch_id
where ci.scheduled_date is not null

union all

-- Open task deadlines (RLS already hides other users' private tasks) --------
select
  'task:' || t.id::text,
  'launch_task',
  t.id,
  'task_due',
  'operations',
  t.task_title,
  nullif(concat_ws(' · ', nullif(t.assigned_to_name, ''), lc.title), ''),
  t.due_date,
  null::date,
  null::time,
  true,
  t.status,
  null::numeric,
  t.assigned_to_user_id,
  '/v2/tasks.html',
  'Task Manager',
  t.company_entity_id
from public.launch_tasks t
left join public.launch_calendar lc on lc.id = t.launch_id
where t.due_date is not null
  and t.status is distinct from 'done'

union all

-- PO requested ship dates (active POs; RLS: admins + creator only) ----------
select
  'po_ship:' || ph.id::text,
  'po',
  ph.id,
  'po_ship',
  'supply_chain',
  ph.po_name,
  nullif(concat_ws(' · ', f.factory_name, 'Requested ship'), ''),
  ph.req_ship_date,
  null::date,
  null::time,
  true,
  ph.status,
  null::numeric,
  null::uuid,
  '/v2/po-builder.html?po_id=' || ph.id::text,
  'PO Builder',
  ph.company_entity_id
from public.po_headers ph
left join public.factories f on f.id = ph.factory_id
where ph.req_ship_date is not null
  and ph.status not in ('Draft', 'Cancelled')

union all

-- PO expected arrivals ------------------------------------------------------
select
  'po_arrival:' || ph.id::text,
  'po',
  ph.id,
  'po_arrival',
  'supply_chain',
  ph.po_name,
  nullif(concat_ws(' · ', f.factory_name, 'Expected arrival'), ''),
  ph.expected_arrival_date,
  null::date,
  null::time,
  true,
  ph.status,
  null::numeric,
  null::uuid,
  '/v2/po-builder.html?po_id=' || ph.id::text,
  'PO Builder',
  ph.company_entity_id
from public.po_headers ph
left join public.factories f on f.id = ph.factory_id
where ph.expected_arrival_date is not null
  and ph.status not in ('Draft', 'Cancelled')

union all

-- Open vendor payments due (RLS: AP managers + own requests) ----------------
select
  'ap:' || pr.id::text,
  'payment_request',
  pr.id,
  'payment_due',
  'finance',
  coalesce(nullif(pr.vendor_name, ''), 'Payment request'),
  nullif(concat_ws(' · ',
    case when pr.invoice_number is not null and pr.invoice_number <> ''
         then 'Inv ' || pr.invoice_number end,
    nullif(pr.request_type, '')), ''),
  pr.due_date,
  null::date,
  null::time,
  true,
  coalesce(nullif(pr.workflow_status, ''), 'open'),
  pr.amount_due,
  pr.assigned_to,
  '/v2/request_manager.html',
  'Request Manager',
  pr.company_entity_id
from public.payment_requests pr
where pr.due_date is not null
  and coalesce(pr.completed, false) = false

union all

-- Paydays (RLS: admins + finance department only) ---------------------------
select
  'payroll:' || pb.id::text,
  'payroll_batch',
  pb.id,
  'payroll_payday',
  'finance',
  'Payroll payday',
  nullif(pb.batch_name, ''),
  pb.check_date,
  null::date,
  null::time,
  true,
  'scheduled',
  null::numeric,
  null::uuid,
  '/payroll.html',
  'Payroll',
  pb.company_entity_id
from public.payroll_import_batches pb
where pb.check_date is not null

union all

-- Claimed TikTok Live slots (timed; slot_start is UTC → shown in Pacific) ---
select
  'live:' || ls.id::text,
  'live_session',
  ls.id,
  'live_session',
  'operations',
  'TikTok Live — ' || coalesce(nullif(p.name, ''), nullif(ls.payee_name, ''), 'claimed slot'),
  nullif(ls.live_location, ''),
  (ls.slot_start at time zone 'America/Los_Angeles')::date,
  null::date,
  (ls.slot_start at time zone 'America/Los_Angeles')::time,
  false,
  ls.status,
  null::numeric,
  ls.claimed_by,
  '/v2/live-schedule.html',
  'Live Schedule',
  ls.company_entity_id
from public.live_sessions ls
left join public.profiles p on p.id = ls.claimed_by

union all

-- Open mailroom action deadlines --------------------------------------------
select
  'mail:' || mi.id::text,
  'mail_item',
  mi.id,
  'mail_due',
  'operations',
  mi.subject,
  nullif(concat_ws(' · ', nullif(mi.sender, ''), nullif(mi.action_needed, '')), ''),
  mi.due_date,
  null::date,
  null::time,
  true,
  mi.status,
  null::numeric,
  mi.assigned_to,
  '/v2/mailroom.html?item=' || mi.id::text,
  'Mailroom',
  mi.company_entity_id
from public.mail_items mi
where mi.due_date is not null
  and mi.status = 'open';
