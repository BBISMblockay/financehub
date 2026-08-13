-- =============================================================================
-- Ask SILO: taught institutional knowledge (silo_chat_notes)
--
-- Ask SILO (/v2/silo-chat.html) has no conversation memory by design (each
-- question is a fresh live query, see docs/ops/silo-chat-setup.md) -- but it
-- had no way to remember a human CORRECTION either. Example that prompted
-- this: "Pin of Month" looks like a slow mover in raw sales data, but it's
-- actually a one-time monthly collectible drop, not a restock/marketing
-- signal -- a fact no query can derive on its own.
--
-- This table is a small, shared knowledge base the silo-chat edge function
-- reads on every request (folded into the system prompt) and writes to via
-- a "save_note" tool when a user explicitly teaches it something. Writing
-- is deliberately narrow -- shared memory means one bad note poisons every
-- future answer for the whole company, so only exec/owner-tier users
-- (is_exec_or_owner(), the same gate used for review-template writes and
-- whole-company roster visibility) can add or remove notes. Reading is
-- broad: every active company member benefits from what's been taught,
-- same as any other RLS-scoped table.
-- =============================================================================

create table if not exists public.silo_chat_notes (
  id uuid primary key default gen_random_uuid(),
  company_entity_id uuid references public.entities(id),
  note text not null check (length(trim(note)) > 0),
  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now()
);

create index if not exists silo_chat_notes_company_created_idx
  on public.silo_chat_notes (company_entity_id, created_at);

alter table public.silo_chat_notes enable row level security;

drop policy if exists silo_chat_notes_active_select on public.silo_chat_notes;
create policy silo_chat_notes_active_select on public.silo_chat_notes
  for select using (company_entity_id = active_company_id());

-- Teaching is exec/owner-only -- see header note on why shared memory needs
-- a narrower write gate than most tables.
drop policy if exists silo_chat_notes_exec_insert on public.silo_chat_notes;
create policy silo_chat_notes_exec_insert on public.silo_chat_notes
  for insert with check (
    company_entity_id = active_company_id()
    and is_exec_or_owner()
  );

drop policy if exists silo_chat_notes_exec_delete on public.silo_chat_notes;
create policy silo_chat_notes_exec_delete on public.silo_chat_notes
  for delete using (
    company_entity_id = active_company_id()
    and is_exec_or_owner()
  );

-- Attribution + company-scoping safety nets (standard pattern).
drop trigger if exists stamp_created_by on public.silo_chat_notes;
create trigger stamp_created_by before insert on public.silo_chat_notes
  for each row execute function public.stamp_created_by();

select public.attach_stamp_company_entity_id_triggers();

-- Enriched view (author display name) for the edge function's context fetch
-- and for direct querying via Ask SILO's own run_sql tool.
drop view if exists public.silo_chat_notes_v;
create view public.silo_chat_notes_v
with (security_invoker = true) as
select
  n.id,
  n.note,
  n.created_at,
  n.created_by,
  p.name as created_by_name,
  n.company_entity_id
from public.silo_chat_notes n
left join public.profiles p on p.id = n.created_by;

revoke all on public.silo_chat_notes from anon;
revoke all on public.silo_chat_notes_v from anon;
grant select, insert, delete on public.silo_chat_notes to authenticated;
grant select on public.silo_chat_notes_v to authenticated;
