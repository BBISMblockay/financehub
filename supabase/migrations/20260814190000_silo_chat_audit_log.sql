-- Ask SILO audit log: every question, the SQL it actually ran, and the
-- answer it gave, per request. This is the prerequisite for closing the
-- feedback loop (can't correct what you can't see) and for a future eval
-- set (can't regression-test prompt changes without recorded examples).
-- Written by the silo-chat edge function using the caller's own JWT, same
-- security model as the rest of the function -- never service role.
create table if not exists public.silo_chat_audit_log (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid references public.entities(id),
  created_by uuid references auth.users(id) on delete set null,
  question text not null,
  history_snapshot jsonb,
  answer text,
  queries_run text[] not null default '{}',
  tool_rounds integer,
  status text not null default 'ok' check (status in ('ok', 'error')),
  error_message text,
  model text,
  created_at timestamptz not null default now()
);

create index if not exists silo_chat_audit_log_company_created_idx
  on public.silo_chat_audit_log (company_entity_id, created_at desc);

alter table public.silo_chat_audit_log enable row level security;

-- Read: your own questions, or everything if you're exec/owner-tier --
-- oversight matches the "ownership will use this heavily" expectation
-- without exposing every team member's questions to each other.
drop policy if exists silo_chat_audit_log_select on public.silo_chat_audit_log;
create policy silo_chat_audit_log_select on public.silo_chat_audit_log
  for select using (
    company_entity_id = active_company_id()
    and (created_by = auth.uid() or is_exec_or_owner())
  );

-- Insert: any active-company member logging their own request. No update
-- or delete policy -- an audit log that can be edited after the fact isn't
-- one.
drop policy if exists silo_chat_audit_log_insert on public.silo_chat_audit_log;
create policy silo_chat_audit_log_insert on public.silo_chat_audit_log
  for insert with check (
    company_entity_id = active_company_id()
    and (created_by = auth.uid() or created_by is null)
  );

drop trigger if exists stamp_created_by on public.silo_chat_audit_log;
create trigger stamp_created_by before insert on public.silo_chat_audit_log
  for each row execute function public.stamp_created_by();

select public.attach_stamp_company_entity_id_triggers();

revoke all on public.silo_chat_audit_log from anon;
grant select, insert on public.silo_chat_audit_log to authenticated;

create or replace view public.silo_chat_audit_log_v
with (security_invoker = true) as
select
  l.id,
  l.company_entity_id,
  l.created_by,
  p.name as created_by_name,
  p.email as created_by_email,
  l.question,
  l.answer,
  l.queries_run,
  l.tool_rounds,
  l.status,
  l.error_message,
  l.model,
  l.created_at
from public.silo_chat_audit_log l
left join public.profiles p on p.id = l.created_by;

revoke all on public.silo_chat_audit_log_v from anon;
grant select on public.silo_chat_audit_log_v to authenticated;
