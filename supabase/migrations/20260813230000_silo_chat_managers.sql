-- =============================================================================
-- Ask SILO access grants, decoupled from the "executive" role
--
-- silo_chat_notes' write gate was is_exec_or_owner() -- correct as a
-- default, but that role also unlocks review-template building and
-- whole-company roster visibility, which is more than "can teach Ask
-- SILO." This adds a narrow, dedicated grant: silo_chat_managers lets an
-- exec/owner hand someone Ask SILO write access specifically, without
-- promoting them to executive company-wide.
--
-- can_manage_silo_notes() = is_exec_or_owner() OR a silo_chat_managers row
-- for that user in their active company. silo_chat_notes' insert/delete
-- policies now check this instead of is_exec_or_owner() directly.
-- =============================================================================

create table if not exists public.silo_chat_managers (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid references public.entities(id),
  user_id uuid not null references public.profiles(id),
  granted_by uuid references public.profiles(id) default auth.uid(),
  granted_at timestamptz not null default now(),
  unique (company_entity_id, user_id)
);

alter table public.silo_chat_managers enable row level security;

-- Exec/owner see and manage the whole grant list (backend.html's toggle).
-- A granted user can also see their OWN row (not anyone else's) -- that's
-- how Ask SILO's own Notes panel self-checks "do I have write access"
-- without needing exec/owner visibility into the full list.
drop policy if exists silo_chat_managers_select on public.silo_chat_managers;
create policy silo_chat_managers_select on public.silo_chat_managers
  for select using (
    company_entity_id = active_company_id()
    and (is_exec_or_owner() or user_id = auth.uid())
  );

drop policy if exists silo_chat_managers_exec_insert on public.silo_chat_managers;
create policy silo_chat_managers_exec_insert on public.silo_chat_managers
  for insert with check (
    company_entity_id = active_company_id()
    and is_exec_or_owner()
  );

drop policy if exists silo_chat_managers_exec_delete on public.silo_chat_managers;
create policy silo_chat_managers_exec_delete on public.silo_chat_managers
  for delete using (
    company_entity_id = active_company_id()
    and is_exec_or_owner()
  );

select public.attach_stamp_company_entity_id_triggers();

create or replace function public.can_manage_silo_notes()
returns boolean
language sql
stable security definer
set search_path = public
as $$
  select public.is_exec_or_owner()
    or exists (
      select 1 from public.silo_chat_managers m
      where m.user_id = auth.uid()
        and m.company_entity_id = public.active_company_id()
    );
$$;

revoke all on function public.can_manage_silo_notes() from public, anon;
grant execute on function public.can_manage_silo_notes() to authenticated, service_role;

-- Broaden silo_chat_notes' write gate from is_exec_or_owner() to
-- can_manage_silo_notes() (a superset -- exec/owner still always pass).
drop policy if exists silo_chat_notes_exec_insert on public.silo_chat_notes;
create policy silo_chat_notes_managers_insert on public.silo_chat_notes
  for insert with check (
    company_entity_id = active_company_id()
    and can_manage_silo_notes()
  );

drop policy if exists silo_chat_notes_exec_delete on public.silo_chat_notes;
create policy silo_chat_notes_managers_delete on public.silo_chat_notes
  for delete using (
    company_entity_id = active_company_id()
    and can_manage_silo_notes()
  );

-- Enriched view for backend.html's grant list (grantee + granter names).
drop view if exists public.silo_chat_managers_v;
create view public.silo_chat_managers_v
with (security_invoker = true) as
select
  m.id,
  m.user_id,
  u.name as user_name,
  u.email as user_email,
  m.granted_by,
  g.name as granted_by_name,
  m.granted_at,
  m.company_entity_id
from public.silo_chat_managers m
left join public.profiles u on u.id = m.user_id
left join public.profiles g on g.id = m.granted_by;

revoke all on public.silo_chat_managers from anon;
revoke all on public.silo_chat_managers_v from anon;
grant select, insert, delete on public.silo_chat_managers to authenticated;
grant select on public.silo_chat_managers_v to authenticated;
