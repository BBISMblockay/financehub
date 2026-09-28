-- Counts shown beside sidebar rows: how many things are waiting on the caller.
--
-- The first is the SEO row: tasks sent for approval (approval_status
-- 'proposed', not yet published) in the caller's active company -- counted only
-- for someone who can approve them, since a count you cannot act on is noise.
-- "Send for approval" on the Tasks tab otherwise notified nobody.
--
-- One function for every badge so the sidebar makes ONE call per page load,
-- and the rule for each count lives here, next to the data, instead of in the
-- sidebar renderer. SECURITY INVOKER: every count is scoped by the caller's own
-- RLS as well as the explicit active-company filter. A row appears only when
-- its count is above zero.
create or replace function public.nav_badge_counts()
returns table (nav_id text, badge_count integer)
language sql
stable
security invoker
set search_path = public
as $$
  select 'reports/seo'::text, count(*)::integer
  from public.seo_tasks t
  where t.company_entity_id = public.active_company_id()
    and t.approval_status = 'proposed'
    and not exists (select 1 from public.seo_task_publications p where p.task_id = t.id)
    and public.can_approve_seo_tasks()
  having count(*) > 0;
$$;

comment on function public.nav_badge_counts() is
  'Sidebar badge counts for the caller: (nav_id, badge_count), a row only when above zero. reports/seo = SEO tasks waiting for approval in the active company, for approvers only. INVOKER; one call per page load from silo-chrome.js.';

-- Supabase's default privileges grant EXECUTE on new public functions to anon.
revoke all on function public.nav_badge_counts() from public, anon;
grant execute on function public.nav_badge_counts() to authenticated;
