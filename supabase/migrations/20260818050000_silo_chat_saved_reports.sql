-- Saved Ask SILO reports.
--
-- A good Ask SILO answer currently dies in one user's chat tab: the
-- agentic discovery that produced it (often 10+ tool rounds) is spent
-- again from scratch the next time anyone asks the same thing -- the
-- 2026-08-17 audit log shows the same restock question asked three times
-- in one evening. This table turns an answer into a shareable, re-runnable
-- artifact: the chat UI saves the question, the final answer, and the
-- exact SQL that produced it (queries_run, already returned by the
-- silo-chat edge function). Re-running is a client-side loop over
-- chat_run_readonly_query -- the same RLS-scoped read-only RPC the chat
-- itself uses -- so a refresh costs zero LLM tokens and no edge-function
-- changes were needed for any of this.
--
-- Read: any active company member (reports are shared team infrastructure,
-- like silo_chat_notes). Write: any member can save; rename/delete is
-- creator or exec/owner.

create table if not exists public.silo_chat_saved_reports (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid references public.entities(id),
  created_by uuid references public.profiles(id),
  title text not null,
  question text not null,
  answer text not null,
  queries_run text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists silo_chat_saved_reports_company_created_idx
  on public.silo_chat_saved_reports (company_entity_id, created_at desc);

alter table public.silo_chat_saved_reports enable row level security;

drop policy if exists silo_chat_saved_reports_select on public.silo_chat_saved_reports;
create policy silo_chat_saved_reports_select on public.silo_chat_saved_reports
  for select using (company_entity_id = active_company_id());

drop policy if exists silo_chat_saved_reports_insert on public.silo_chat_saved_reports;
create policy silo_chat_saved_reports_insert on public.silo_chat_saved_reports
  for insert with check (
    company_entity_id = active_company_id()
    and (created_by = auth.uid() or created_by is null)
  );

drop policy if exists silo_chat_saved_reports_update on public.silo_chat_saved_reports;
create policy silo_chat_saved_reports_update on public.silo_chat_saved_reports
  for update using (
    company_entity_id = active_company_id()
    and (created_by = auth.uid() or is_exec_or_owner())
  )
  with check (
    company_entity_id = active_company_id()
    and (created_by = auth.uid() or is_exec_or_owner())
  );

drop policy if exists silo_chat_saved_reports_delete on public.silo_chat_saved_reports;
create policy silo_chat_saved_reports_delete on public.silo_chat_saved_reports
  for delete using (
    company_entity_id = active_company_id()
    and (created_by = auth.uid() or is_exec_or_owner())
  );

drop trigger if exists stamp_created_by on public.silo_chat_saved_reports;
create trigger stamp_created_by before insert on public.silo_chat_saved_reports
  for each row execute function public.stamp_created_by();

drop trigger if exists set_updated_at on public.silo_chat_saved_reports;
create trigger set_updated_at before update on public.silo_chat_saved_reports
  for each row execute function public.set_updated_at();

-- Attaches the stamp_company_entity_id BEFORE INSERT trigger here (and
-- refreshes it everywhere else) so the UI can omit company_entity_id.
select public.attach_stamp_company_entity_id_triggers();

revoke all on public.silo_chat_saved_reports from anon;
grant select, insert, update, delete on public.silo_chat_saved_reports to authenticated;

create or replace view public.silo_chat_saved_reports_v
with (security_invoker = true) as
select
  r.id,
  r.company_entity_id,
  r.created_by,
  p.name as created_by_name,
  r.title,
  r.question,
  r.answer,
  r.queries_run,
  r.created_at,
  r.updated_at
from public.silo_chat_saved_reports r
left join public.profiles p on p.id = r.created_by;

revoke all on public.silo_chat_saved_reports_v from anon;
grant select on public.silo_chat_saved_reports_v to authenticated;
