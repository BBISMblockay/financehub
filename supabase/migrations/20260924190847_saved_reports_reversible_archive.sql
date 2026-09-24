-- Applied to production 2026-09-24. Archive state is separate from titles.
-- Existing dashboard_widgets_v reads the base table, so archived reports keep running.
-- Restore with UPDATE silo_chat_saved_reports SET archived_at = NULL WHERE id = ...;
-- No permission changes: existing base-table RLS governs reads and updates.
alter table public.silo_chat_saved_reports add column if not exists archived_at timestamptz;
comment on column public.silo_chat_saved_reports.archived_at is 'Hidden from the active report library and new-widget picker when set. Queries and existing dashboard references remain intact. Clear to restore.';
create or replace view public.silo_chat_saved_reports_v with (security_invoker = true) as
select r.id, r.company_entity_id, r.created_by, p.name as created_by_name,
r.source, r.title, r.description, r.question, r.answer, r.queries_run,
r.visibility, r.columns_metadata, r.parameters, r.created_at, r.updated_at,
r.row_estimate, r.row_estimate_at
from public.silo_chat_saved_reports r left join public.profiles p on p.id=r.created_by
where r.archived_at is null;
