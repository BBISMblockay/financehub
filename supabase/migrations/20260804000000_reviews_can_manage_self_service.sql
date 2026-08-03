-- ============================================================
-- 20260804000000_reviews_can_manage_self_service.sql
--
-- Performance Reviews / roster RLS was requiring SILO admin+ role
-- (owner/executive/admin) via reviews_can_manage() just to add and
-- review YOUR OWN direct reports -- conflating "is a SILO admin" with
-- "is somebody's manager". Every write policy already scopes to
-- (manager_user_id = auth.uid() OR is_exec_or_owner()) on top of that,
-- so the role check added nothing except locking any future non-admin
-- manager (a retail store manager, say) out of managing their own
-- team's reviews entirely. Confirmed against a real report: Jon Loomis
-- (admin role) couldn't tell why "Add to roster" was failing for a
-- report someone else had already added under a different manager --
-- unrelated to this gate, but exposed that the manager-vs-admin
-- conflation was undocumented and confusing ("do I need to make
-- managers execs?").
--
-- Decision: Blake stays company-wide super-admin via is_exec_or_owner()
-- (owner_admin membership) and template building stays exec-only via
-- review_templates' separate is_exec_or_owner() gate -- both untouched.
-- Any active SILO user can now roster and review their own direct
-- reports, full stop, no admin/exec role required.
--
-- Redefining the function (rather than touching the ~15 policies that
-- call it) is deliberate: every reviews_can_manage() + manager/exec
-- policy pair updates in one place, with the real per-row scoping
-- (own reports vs. sees-everyone) left exactly as-is.
-- ============================================================

create or replace function public.reviews_can_manage()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and coalesce(p.is_active, true) = true
  );
$function$;

comment on function public.reviews_can_manage() is
  'True for any active SILO user (previously required owner/executive/admin role). The real per-row scoping -- own direct reports vs. sees-everyone -- lives in each policy''s own (manager_user_id = auth.uid() OR is_exec_or_owner()) clause, not here. Do not reintroduce a role check here without updating every caller''s intent.';
