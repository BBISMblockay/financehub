-- My reports vs Company reports for Ask SILO saved reports.
--
-- Every saved report was company-visible, which polluted the shared list
-- with personal daily-workflow reports (an accounting person's morning
-- tie-out, an analyst's scratch queries). New `visibility` column:
--   'company' (default) -- shared team report, everyone in the company
--                          sees it (unchanged behavior; all existing rows
--                          backfill to this via the column default)
--   'private'           -- "My reports": visible ONLY to its creator.
--                          Deliberately also hidden from exec/owner --
--                          same author-only stance as review_private_notes.
-- The save flow on /v2/silo-chat.html now asks which one at save time.

alter table public.silo_chat_saved_reports
  add column if not exists visibility text not null default 'company';

do $$ begin
  alter table public.silo_chat_saved_reports
    add constraint silo_chat_saved_reports_visibility_check
    check (visibility in ('company', 'private'));
exception when duplicate_object then null; end $$;

-- Select: company reports for everyone in the company, private ones only
-- for their creator.
drop policy if exists silo_chat_saved_reports_select on public.silo_chat_saved_reports;
create policy silo_chat_saved_reports_select on public.silo_chat_saved_reports
  for select using (
    company_entity_id = active_company_id()
    and (visibility = 'company' or created_by = auth.uid())
  );

-- Insert/update/delete policies are unchanged: any member saves, creator or
-- exec/owner mutates -- and since exec/owner can no longer SELECT someone
-- else's private report, their mutate rights only ever reach company ones.

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
  r.updated_at,
  r.visibility
from public.silo_chat_saved_reports r
left join public.profiles p on p.id = r.created_by;

revoke all on public.silo_chat_saved_reports_v from anon;
grant select on public.silo_chat_saved_reports_v to authenticated;
