-- Scope the entity admin gate to the entity being acted on.
--
-- is_owner_admin() asked "do I hold an owner/admin membership ANYWHERE" and
-- then answered true for EVERY company:
--
--   select exists (select 1 from entity_memberships m
--                   where m.user_id = auth.uid()
--                     and m.role in ('owner','admin'));
--
-- There is no entity_id predicate. 20260913054723 diagnosed this same root
-- cause for `profiles` and fixed it THERE; the function stayed in place for
-- everything else, which is the rest of it.
--
-- Measured against production 2026-09-20, impersonating a BlockayOps-only
-- membership 'admin' (blake@verdazepdx.com, one membership, not a platform
-- admin). Operational isolation held -- 0 payment_requests, 0 po_headers,
-- 0 launch_calendar rows, profiles correctly returned only the 2 BlockayOps
-- members -- but:
--
--   entities visible: 3  (Baseballism, BlockayOps, Test Company, with
--                         entity_key) via entities_select_access
--                       -> can_access_entity(id) -> is_owner_admin()
--   is_owner_admin(): true
--
-- So any admin of any tenant could list every tenant, and -- the same
-- unscoped gate being the ENTIRE qual of entities_delete_admin_only, with
-- DELETE still granted to authenticated (20260920130000 revoked UPDATE only)
-- -- delete one. Deleting Baseballism would in fact fail: ~70 child FKs are
-- NO ACTION and populated, so the statement aborts atomically. That is
-- accidental protection, not design: a young tenant has no rows in those
-- tables, and ~70 OTHER FKs are CASCADE (company_settings, entity_memberships,
-- shopify_connections, billing_subscriptions, stripe_connect_accounts, every
-- customer_account*). 28 of 29 Baseballism profiles are membership 'admin'.
--
-- Not tested by deleting anything: entity triggers reach notify-slack through
-- pg_net, which is not transactional, so a rolled-back probe still fires.

-- 1. The vocabulary is stale, and it fails in BOTH directions.
--
-- Per-company roles are owner_admin | admin | member | viewer (20260714232106).
-- 'owner' matches NO row in production (measured: 33 admin, 3 owner_admin,
-- 2 member, 0 owner), so is_entity_admin -- which is otherwise correctly
-- scoped -- currently excludes every owner_admin from their OWN company,
-- while is_owner_admin admitted every admin to EVERY company.
create or replace function public.is_entity_admin(p_entity_id uuid)
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
    where m.entity_id = p_entity_id
      and m.user_id = auth.uid()
      and m.role in ('owner_admin', 'admin')
  );
$$;

comment on function public.is_entity_admin(uuid) is
  'True when the caller holds an owner_admin/admin membership of THIS entity. Company-scoped: takes the entity being acted on. DEFINER + row_security off so a policy on entity_memberships cannot re-enter its own RLS.';

-- 2. Drop the unscoped branch out of can_access_entity.
--
-- The remaining branches are all row-specific: the row's own created_by, an
-- entity_state assignment to the caller, or membership of that entity. The
-- two client reads of `entities` are both already scoped to one company
-- (pages/config.js reads .eq('id', active_company_id); company-picker reads
-- entity_memberships!inner), so nothing in the app depends on the wide branch.
create or replace function public.can_access_entity(eid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
set row_security = off
as $$
  select
    exists (
      select 1
      from public.entities e
      where e.id = eid
        and e.created_by = auth.uid()
    )
    or exists (
      select 1
      from public.entity_state s
      where s.entity_id = eid
        and s.assigned_to = auth.uid()
    )
    or public.is_entity_member(eid);
$$;

comment on function public.can_access_entity(uuid) is
  'True when the caller may see THIS entity: they created it, are assigned to it, or are a member of it. The is_owner_admin() branch was removed 20260920160000 -- it had no entity_id predicate and matched every entity.';

-- 3. Retire the four policies built on the unscoped gate.
--
-- Each of these four tables ALREADY carries a correctly scoped sibling
-- (is_entity_admin(<that row's entity>)), so the broken policies were pure
-- widening duplicates -- and policies are OR'd, so leaving one in place keeps
-- the hole open regardless of the function fix above.
drop policy if exists entities_delete_admin_only on public.entities;          -- dup of entities_delete_admin
drop policy if exists entity_state_delete_admin_only on public.entity_state;  -- dup of state_delete_admin

-- These two also carried an author/uploader clause, which is NOT a duplicate
-- and is preserved on its own. The admin half is already covered by
-- comments_delete_admin / files_delete_admin.
drop policy if exists entity_comments_delete_admin_or_author on public.entity_comments;
drop policy if exists entity_comments_delete_author on public.entity_comments;
create policy entity_comments_delete_author on public.entity_comments
  for delete to authenticated
  using (created_by = auth.uid());

drop policy if exists files_delete_admin_or_uploader on public.files;
drop policy if exists files_delete_uploader on public.files;
create policy files_delete_uploader on public.files
  for delete to authenticated
  using (uploaded_by = auth.uid());

-- 4. Remove the function itself, now that nothing references it.
--
-- Verified against pg_policy, pg_proc, pg_views/matviews, pg_constraint and
-- pg_attrdef before writing this: exactly five references existed, all four
-- policies above plus can_access_entity, all rewritten. Dropped rather than
-- corrected because a zero-argument "am I an admin" helper cannot be scoped to
-- a row -- the next caller would reintroduce the same hole. Scoped callers
-- have is_entity_admin(uuid); "owner of the company I am ACTIVE in" has
-- is_owner_admin_of_active_company().
drop function if exists public.is_owner_admin();

-- 5. A company is not a row a browser edits.
--
-- 20260920130000 revoked UPDATE for this reason and stopped there. DELETE is
-- the same argument and a worse outcome; INSERT is the same argument pointing
-- the other way -- entities_insert_active_user admits any active user, which
-- would let a browser FOUND a tenant outside the platform-invite flow that
-- 20260918120000 exists to enforce.
--
-- Safe because every legitimate writer is SECURITY DEFINER and so is unaffected
-- by these grants (verified: redeem_platform_invite, handle_new_user,
-- set_workspace_company_name), and no client code writes this table at all
-- (grep: the only two uses are selects).
revoke insert, delete on public.entities from authenticated;
revoke insert, delete on public.entities from anon;
