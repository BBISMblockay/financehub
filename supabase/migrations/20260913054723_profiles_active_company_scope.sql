-- Scope profile visibility to the caller's ACTIVE company.
--
-- Reported live: while active in Test Company, every Baseballism person appeared
-- in the assignee dropdown on /v2/tasks.html. The page is not at fault — it runs
-- the same `select id,name,email where is_active order by name` that eleven other
-- people-pickers run, and relied on RLS for scoping. RLS was not scoping it.
--
-- profiles carried three SELECT policies, OR'd together, none of which
-- constrained the ROW being read to a company:
--
--   profiles_select_own                  auth.uid() = id
--   profiles_select_self_or_admin        is_owner_admin() OR id = auth.uid()
--   profiles_internal_assignment_select  current_user_can_manage_payment_requests()
--
-- is_owner_admin() asks "am I owner/admin of ANY entity" -- it has no entity_id
-- filter -- so an owner of one tenant matched it while active in another and read
-- every profile in the database. The third policy leaks differently: its GATE is
-- company-aware, but it applies no filter to the rows returned, so passing the
-- gate returns everyone.
--
-- profiles has no company_entity_id of its own (a person can belong to several
-- companies), so the scope has to come from entity_memberships.
--
-- Measured against production before writing this, so the blast radius is known
-- rather than hoped for:
--   Baseballism viewers   34 visible -> 33   (loses only "Blake Tester", a
--                                            Test-Company-only account that was
--                                            never a Baseballism person)
--   Test Company viewers  34 visible ->  2   (the leak)
--   Profiles with no membership anywhere: 0  (nobody is orphaned by this)
-- Every viewer keeps their own row regardless of membership.

-- SECURITY DEFINER with row_security off, matching is_owner_admin() and
-- active_company_id(). A policy on profiles that read entity_memberships
-- directly would re-enter that table's own RLS -- whose policies call
-- is_entity_member()/is_entity_admin(), which read memberships again.
create or replace function public.shares_active_company(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
set row_security = off
as $$
  select exists (
    select 1
    from public.entity_memberships m
    where m.user_id = p_user
      and m.entity_id = public.active_company_id()
  );
$$;
revoke all on function public.shares_active_company(uuid) from public, anon;
grant execute on function public.shares_active_company(uuid) to authenticated;

comment on function public.shares_active_company(uuid) is
  'True when the given profile belongs to the caller''s active company. Used by profiles RLS; DEFINER + row_security off to avoid re-entering entity_memberships RLS.';

-- One SELECT policy replaces all three. Policies are OR'd, so leaving any of the
-- unscoped ones in place would keep the leak open.
drop policy if exists profiles_select_own on public.profiles;
drop policy if exists profiles_select_self_or_admin on public.profiles;
drop policy if exists profiles_internal_assignment_select on public.profiles;
drop policy if exists profiles_select_active_company on public.profiles;
create policy profiles_select_active_company on public.profiles
  for select to authenticated
  using (
    id = auth.uid()
    or public.shares_active_company(id)
  );

-- Same root cause on the write side: is_owner_admin() let an admin of any tenant
-- update any profile in the database. The backend admin screens are unaffected --
-- admin_update_profile() is SECURITY DEFINER and bypasses RLS -- so this governs
-- only direct client updates, which are self-edits from /v2/profile.html.
drop policy if exists profiles_update_own on public.profiles;
drop policy if exists profiles_update_self_or_admin on public.profiles;
drop policy if exists profiles_update_active_company on public.profiles;
create policy profiles_update_active_company on public.profiles
  for update to authenticated
  using (
    id = auth.uid()
    or (public.is_owner_admin() and public.shares_active_company(id))
  )
  with check (
    id = auth.uid()
    or (public.is_owner_admin() and public.shares_active_company(id))
  );
